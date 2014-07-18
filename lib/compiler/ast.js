/**
 * hyperloop compiler
 */
var fs = require('fs'),
	path = require('path'),
	Uglify = require('uglify-js'),
	log = require('../log'),
	util = require('../util'),
	typelib = require('./type'),
	jsgen = require('./jsgen'),
	_ = require('underscore');

exports.compile = compile;
exports.compress = compress;

// expose only for testing
exports.testing = {
	fail: fail,
	isBuiltinObject: isBuiltinObject,
	isJSBuiltinObject: isJSBuiltinObject,
	isDefined: isDefined,
	splitClassWithStaticField: splitClassWithStaticField,
	makeArrayFromArg: makeArrayFromArg,
	toValue: toValue,
	evalExpression: evalExpression,
	makeDictionaryFromArg: makeDictionaryFromArg,
	hyperloopNodeToUglifyNode: hyperloopNodeToUglifyNode,
	uglifyNodeToHyperloopNode: uglifyNodeToHyperloopNode,
	addArgumentToDict: addArgumentToDict,
	generateHyperloopCommand: generateHyperloopCommand,
	getInitClassFromSource: getInitClassFromSource,
	generateNewConstructor: generateNewConstructor,
	generateMethodCall: generateMethodCall,
	generateMethodCall2: generateMethodCall2,
	generateMethodCall3: generateMethodCall3,
	generateClassMethodCall: generateClassMethodCall,
	generateFunctionCall: generateFunctionCall,
	generateStaticGetter: generateStaticGetter,
	generateGetterCall: generateGetterCall,
	generateSetterCall: generateSetterCall,
	printTraceInfo: printTraceInfo,
	compileCommand: compileCommand
};

function fail(node, msg, extra) {
	throw new Error(msg+" at "+(node.start.file+":"+node.start.line).green+(extra?"\n\n"+extra:''));
}

function isBuiltinObject(name) {
	return /^(console)$/.test(name) || isJSBuiltinObject(name);
}

function isJSBuiltinObject(name) {
	return /^(JSON|Math|String|Date|RegExp|Array|Object|Error|require)$/.test(name) ||
			isMochaObject(name);
}

function isMochaObject(name) {
	return /^(mocha|it|describe)$/.test(name);
}

/**
 * check have to make sure to 0 (number) isn't interpreted as false -
 * so we must make sure a check for not specifically undefined or null
 */
function isDefined(value) {
	return !!(value!==null && value!==undefined);
}

/**
 * split fully qualified static property into class and field
 *
 * e.g.
 * java.lang.String.CASE_INSENSITIVE_ORDER -> {name:'java.lang.String', field:'CASE_INSENSITIVE_ORDER'}
 */
function splitClassWithStaticField(library, state, name) {
	if (!name || name.indexOf('.') == -1) return null;
	var t1 = name.substr(0, name.lastIndexOf('.'));
	var t2 = name.substr(t1.length+1);
	var property = _.clone(library.findProperty(state.metabase, t1, t2));
	if (property) {
		if (property.instance === false || typeof(property.instance)==='undefined') {
			return {name:t1, property:property};
		} else {
			throw new Error('Invalid field access for '+name+', this is not a static field');
		}
	}
	return null;
}

/**
 * turn an AST node array into a JS array
 */
function makeArrayFromArg(arg, node, globals) {
	var array = [];
	if (arg.elements && arg.elements.length) {
		arg.elements.forEach(function(a){
			if (isDefined(a.value)) {
				array.push(a.value);
			}
			else if (a.name) {
				var value = (node && node.scope || node.expression && node.expression.scope) ? (node.scope ? (node.scope) : (node.expression.scope)).find_variable(a.name) : null;
				array.push(isDefined(value) && v || a.name);
			}
			else {
				var v = toValue(a,node,globals);
				isDefined(v) && array.push(v);
			}
		});
	}
	return array;
}

/**
 * turn an AST node value into a JS value
 */
function toValue(value, node, globals) {
	//if (!isDefined(value)) return null;

	if (value.elements) {
		value = makeArrayFromArg(value,node,globals);
	}
	else if (value.properties) {
		value = makeDictionaryFromArg(value,node,globals);
	}
	else if (isDefined(value.value)) {
		value = value.value;
	}
	else if (value.body) {
		return {
			metatype:'function',
			argnames: value.argnames.map(function(a){return a.name}),
			body: value.print_to_string()
		};
	}
	else if (value.name) {
		return value.name;
	}
	else if (value.left && value.right && value.operator) {
		// this is an expression
		value = evalExpression(node,value,globals);
	}
	else if (value.expression && value.expression.value && value.operator) {
		// this is something like -1.0
		return eval(value.operator+value.expression.value);
	}
	return value;
}

/**
 * attempt to static evaluate an AST expression into a JS string
 */
function evalExpression(node, arg, globals) {
	var scope = {},
		expr = [],
		vars = node.expression.scope ? node.expression.scope.variables._values : node.expression.expression.scope && node.expression.expression.scope.variables._values,
		fn;
	//expand our scope into function args that we can invoke to resolve the value
	for (var k in vars) {
		var v = vars[k].init && vars[k].init.value;
		scope[k.substring(1)] = v;
		expr.push(v);
	}
	try {
		var prepend = '';
		// put globals inside the function scope so that you can use them as global variables
		globals && Object.keys(globals).forEach(function(k){
			var o = globals[k];
			if (typeof(o)==='function' || typeof(o)==='object') return;
			prepend+='const '+k+' = \"'+o+'\"; ';
		});
		fn = "(function("+Object.keys(scope).join(",")+"){ "+prepend+" return " + arg.left.print_to_string() + arg.operator + arg.right.print_to_string() + "; })";
		var expression = eval(fn);
		return expression.apply(scope,expr);
	}
	catch(E){
		var r = /(\w+) is not defined/,
			m = r.exec(E.message);
		if (m) {
			throw new Error("can't seem to determine value of "+m[1].red+" during import at "+node.start.file+' on line '+node.start.line);
		}
		throw E;
	}
}

/**
 * turn a AST node dictionary into a JS dictionary
 */
function makeDictionaryFromArg(arg, node, globals) {
	var obj = {};
	arg.properties.forEach(function(p) {
		obj[p.key] = toValue(p.value, node, globals);
	});
	return obj;
}

function hyperloopNodeToUglifyNode (arg) {
	switch (arg.type) {
		case 'undefined': {
			return new Uglify.AST_Undefined();
		}
		case 'variable': {
			return new Uglify.AST_SymbolFunarg({name:arg.value});
		}
		case 'null': {
			return new Uglify.AST_Null();
		}
		case 'boolean': {
			return arg.value ? new Uglify.AST_True() : new Uglify.AST_False();
		}
		case 'expression':
		case 'eval': 
		case 'value': {
			switch (arg.metatype || (arg.start && arg.start.type) || typeof(arg.value)) {
				case 'number':
				case 'num': {
					return new Uglify.AST_Number({value:arg.value});
				}
				case 'string': {
					return new Uglify.AST_String({value:arg.value});
				}
				case 'boolean': {
					return arg.value ? new Uglify.AST_True() : new Uglify.AST_False();
				}
				case 'undefined': {
					return new Uglify.AST_Undefined();
				}
				case 'null': {
					return new Uglify.AST_Null();
				}
				default: {
					throw new Error('not sure how to handle',arg)
				}
			}
			return new Uglify.AST_SymbolFunarg({name:JSON.stringify(arg.value)});
		}
		case 'dict': {
			return new Uglify.AST_Object({
				properties: Object.keys(arg.value).map(function(key){ 
					// log.fatal('here',key,arg.value[key],arg.value[key])
					var obj = arg.value[key],
						value = hyperloopNodeToUglifyNode(obj);
					//log.fatal(key,obj,value)
					return new Uglify.AST_ObjectKeyVal({
						key: key,
						value: value
					});
				})
			});
		}
		case 'array': {
			return new Uglify.AST_Array({
				elements: arg.value.map(function(a){
					return hyperloopNodeToUglifyNode(a);
				})
			});
		}
		default: {
			//TODO
			throw new Error("argument conversion to AST not supported for",arg);
		}
	}
}

/**
 * given an AST node, return a Hyperloop version of the node
 */
function uglifyNodeToHyperloopNode (arg, node){ 
	if (arg.elements) {
		return {
			type: 'array',
			value: arg.elements.map(function(e){
				return uglifyNodeToHyperloopNode(e,node);
			})
		};
	}
	else if (arg.properties) {
		var map = {};
		arg.properties.forEach(function(p) { 
			map[p.key] = uglifyNodeToHyperloopNode(p.value,node);
		});
		return {
			type: 'dict',
			value: map
		}
	}
	else if (arg.name === 'undefined' || (arg.operator === 'void' && arg.expression && arg.expression.value === 0)) {
		return {
			type: 'undefined',
			value: undefined
		};
	}
	else if (arg.name) {
		return {
			type: 'variable',
			value: arg.name
		};
	}
	else if (arg.body) {
		return {
			type: 'function',
			argnames: arg.argnames.map(function(a){return a.name}),
			value: arg.print_to_string()
		};
	}
	else if (arg.left && arg.right && arg.operator) {
		return {
			type: 'expression',
			value: evalExpression(node,arg,{})
		};
	}
	else if (arg.start.type==='atom') {
		switch (arg.start.value) {
			case 'null': {
				return {type:'null',value:null};
			}
			case 'true': {
				return {type:'boolean',value:true};
			}
			case 'false': {
				return {type:'boolean',value:false};
			}
			default: {
				throw new Error("don't know how to deal with atom: "+arg);
			}
		}
	}
	else if (isDefined(arg.value)) {
		return {
			type: 'value',
			value: arg.value,
			metatype: arg.start.type
		};
	}
	else if (arg.expression && arg.expression.value && arg.operator) {
		return {
			type: 'eval',
			value: eval(arg.operator+arg.expression.value)
		};
	}
	throw new Error("i don't know what this is "+arg);
}

/**
 * add an AST node as an argument to a dictionary
 */
function addArgumentToDict (dict, args, node, key) {
	var entry = dict[key];
	if (args) {
		args.forEach(function(arg){
			var value = uglifyNodeToHyperloopNode(arg,node);
			if (entry && Array.isArray(entry)) {
				entry.push(value);
			}
			else {
				dict[key] = entry = entry ? [entry, value] : [value];
			}
		});
	}
	if (!entry) {
		dict[key]=[];
	}
}

function generateHyperloopCommand(expr, prev, dict) {
	var command, first = expr;
	while (expr) {
		if (expr.property) {
			addArgumentToDict(dict, prev && prev.args, prev, expr.property);
			command = expr.property;
		}
		prev = expr;
		expr = expr.expression;
	}
	return command;
}

function getInitClassFromSource(state, source, node) {
	if (node.$start) {
		var lookup = state.node_map[JSON.stringify(node.$start)];
		if (lookup && lookup.class) {
			return typelib.resolveType(lookup.class).toSafeClassName();
		}
	}
	if (node.expression && node.expression.name) {
		var lookup = state.symbols[node.expression.name];
		if (lookup) {
			// TODO combine with common code from lines 762+
			var name = (lookup.type === 'constructor') ? lookup['class'] : lookup['returnType'];
			// If the returntype is id, we may want to cheat and assume the return type is the class
			if (name == 'id') {
				name = lookup['class'];
			}
			return typelib.resolveType(name).toSafeClassName();
		}
	}

	if (node.thedef && node.thedef.init && node.thedef.init.expression) {
		var expr = node.thedef.init.expression;
		if (expr.start.value == 'Hyperloop') {
			var lookup = state.node_map[JSON.stringify(expr.start)];
			if (lookup && lookup.class) {
				return typelib.resolveType(lookup.class).toSafeClassName();
			}
		} else if (expr.property == 'cast' && node.thedef.init.args.length == 1) {
			return node.thedef.init.args[0].value;
		} else if (node.thedef.orig && node.thedef.orig[0]) {
			var lookup = state.node_map[JSON.stringify(node.thedef.orig[0].start)];
			if (lookup) {
				if (lookup.type == 'constructor') {
					return typelib.resolveType(lookup.class).toSafeClassName();
				} else if (lookup.type == 'function' && lookup.returnType) {
					return typelib.resolveType(lookup.returnType).toSafeClassName();
				} else if (lookup.type == 'method' && lookup.class) {
					return typelib.resolveType(lookup.returnType).toSafeClassName();
				} else if (lookup.property && lookup.property.type) {
					return typelib.resolveType(lookup.property.type).toSafeClassName();
				} else {
					return expr.print_to_string();
				}
			} else {
				return expr.print_to_string();
			}
		} else {
			return expr.print_to_string();
		}
	}
	return undefined;
}

function toExpressionStack (node) {
	var expr = node.expression,
		stack = [],
		prev,
		prevnode = expr,
		prevargs;
	while(expr) {
//		console.log(expr.print_to_string().green);
		if (expr.property) {
			stack.push((prev={
				property: expr.property,
				args: node.args || [],
				node: expr
			}));
		}
		else if (expr.args) {
			prevargs = expr.args;
		}
		prevnode = expr;
		expr = expr.expression;
	}
	stack.unshift({
		args: prevargs || [],
		node: prevnode
	});
	return stack;
}

function compile (options, state, library, arch, source, filename, jsfilename, build_opts) {
	// parse the JS file
	var ast = Uglify.parse(source, {
		filename: filename
	});
	ast.figure_out_scope();

	var foundUseHyperloopDirective = false;

	state.node_map = {};
	state.var_map = {};

	if (typeof(build_opts.OBFUSCATE)=='boolean') {
		state.obfuscate = build_opts.OBFUSCATE;
	}
	else {
		state.obfuscate = typeof(options.obfuscate)==='undefined' ? true : options.obfuscate;
	}

	var dumpAST = build_opts.DUMP_AST;

	// create the AST transformer
	var transformer = new Uglify.TreeTransformer(null, function(node, descend){
		dumpAST && log.info(node.TYPE.yellow,node.print_to_string().magenta)
		if (node instanceof Uglify.AST_Directive) {
			if (node.value==='use hyperloop') {
				foundUseHyperloopDirective = true;
				return new Uglify.AST_EmptyStatement();
			}
		}
		if (!foundUseHyperloopDirective) {
			return;
		}
		if (node instanceof Uglify.AST_New) {
			var name = node.expression.name || node.expression.print_to_string();
			if (!isBuiltinObject(name) && library.isValidSymbol(state, name)) {
				return generateNewConstructor(library, state, name, node);
			}
			else if (!isBuiltinObject(name) && node.expression && node.expression.thedef && node.expression.thedef.undeclared) {
				fail(node, name.yellow+" is an undefined symbol");
			}
		}
		else if (node instanceof Uglify.AST_Dot) {
			var p = transformer.parent();
			// if we're actually calling a query method, DO NOT OVERRIDE WITH FIELD/PROPERTY ACCESS
			if (!(p instanceof Uglify.AST_Call)) {
				var varStatic = splitClassWithStaticField(library, state, node.print_to_string());
				if (varStatic) {
					log.debug("Generating static getter: " + JSON.stringify(varStatic));
					return generateStaticGetter(library, state, varStatic.name, varStatic.property, node);
				}
			}
			var cls = getInitClassFromSource(state, source, node.expression);
			var field = node.property;
			var instance = node.expression;

			if (!cls && node.expression.hyperloop && node.expression.hyperloop.property) {
				var expr_type = typelib.resolveType(node.expression.hyperloop.property.type);
				cls = expr_type.toName();
			}
			var property = _.clone(library.findProperty(state.metabase, cls, field));
			// search for function
			if (!property && library.findFunction) {
				var func = library.findFunction(state.metabase, cls);
				if (func) {
					cls = func.returnType;
					property = library.findProperty(state.metabase, cls, field);
				}
			}

			if (cls && !jsgen.isBuiltinFunction(field) && property) {
				return generateGetterCall(library, state, cls, property, instance, node);
			}
		}
		else if (node instanceof Uglify.AST_Assign) {
			if (node.left.hyperloop && node.left.hyperloop.type==='getter') {
				var cls = node.left.hyperloop.class;
				var field = node.left.hyperloop.property.name;
				var right = node.right;
				// assignment operator such as '+=' and '>>>='
				if (node.operator != '=') {
					right = new Uglify.AST_Binary({
						start: node.start,
						operator: node.operator.substr(0, node.operator.length-1),
						left: node.left,
						right: node.right
					});
				}
				// Detect multiple assignments and transform so subsequent access uses getter to get value to assign
				if (right.hyperloop && right.hyperloop.type==='setter') {
						// Ok, now we need to transform so right node here is actually a getter
						var property = _.clone(library.findProperty(state.metabase, right.hyperloop.class, right.hyperloop.property));
						var oldAssign = right; // retain old "right" node which is a setter. We'll inject that above this one
						right = generateGetterCall(library, state, right.hyperloop.class, property, right.args[0], right);
						if (cls && !jsgen.isBuiltinFunction(field) && library.findProperty(state.metabase, cls, field)) {
							var result = generateSetterCall(library, state, cls, field, node.left.hyperloop.instance, right, node);
							return new Uglify.AST_Array({elements:[oldAssign, result]});
						}
				}
				if (cls && !jsgen.isBuiltinFunction(field) && library.findProperty(state.metabase, cls, field)) {
					return generateSetterCall(library, state, cls, field, node.left.hyperloop.instance, right, node);
				}
			}
			if (node.left.thedef && node.left.thedef.orig) {
				var key = JSON.stringify(node.left.thedef.orig[0].start),
					val = state.node_map[key];
				if (val && val.returnType) {
					var match = val.returnType.match(/^(void|float|int|uint|long|short|ushort|double|bool|char)\s\*$/);
					if (match) {
						var setter = 'Hyperloop_Memory_Set_'+match[1];
						state.builtin_symbols = state.builtin_symbols || {};
						state.builtin_symbols[setter] = match[1];
						return new Uglify.AST_Call({
							args: [node.left, new Uglify.AST_Number({value:0,start:node.start,end:node.end}), node.right],
							expression: new Uglify.AST_SymbolRef({name:setter,start:node.start,end:node.end}),
							start: node.start
						});
					}
				}
			}
			if (node.left.hyperloop && node.left.hyperloop.type==='memory_getter') {
				if (node.operator == '=') {
					state.builtin_symbols = state.builtin_symbols || {};
					state.builtin_symbols[node.left.hyperloop.setter] = node.left.hyperloop.class;
					return new Uglify.AST_Call({
						args: [node.left.args[0], node.left.args[1], node.right],
						expression: new Uglify.AST_SymbolRef({name:node.left.hyperloop.setter,start:node.start,end:node.end}),
						start: node.start
						});
				} else {
					log.fatal('Binary operation for void* type does not support \''+node.operator+'\'');
				}
			}
		}
		else if (node instanceof Uglify.AST_Binary) {
			// if binary equals operation involves native object, call native 'IsEqual' operation
			if (node.operator == '==' || node.operator == '===') {
				if (getInitClassFromSource(state, source, node.right) || getInitClassFromSource(state, source, node.left)) {
					var binarySymbol = node.operator == '===' ? 'Hyperloop_Binary_IsStrictEqual' : 'Hyperloop_Binary_IsEqual';
					state.builtin_symbols = state.builtin_symbols || {};
					state.builtin_symbols[binarySymbol] = node.operator;
					return new Uglify.AST_Call({
						args: [node.left, node.right],
						expression: new Uglify.AST_SymbolRef({name:binarySymbol,start:node.start,end:node.end}),
						start: node.start
					});
				}
			} else if (node.operator == 'instanceof') {
				if (getInitClassFromSource(state, source, node.right) || getInitClassFromSource(state, source, node.left)) {
					var binarySymbol = 'Hyperloop_Binary_InstanceOf';
					state.builtin_symbols = state.builtin_symbols || {};
					state.builtin_symbols[binarySymbol] = node.operator;
					return new Uglify.AST_Call({
						args: [node.left, node.right],
						expression: new Uglify.AST_SymbolRef({name:binarySymbol,start:node.start,end:node.end}),
						start: node.start
					});
				}
			}
		}
		else if (node instanceof Uglify.AST_VarDef) {
			if (node.value) {
				var key = JSON.stringify(node.value.start),
					val = state.node_map[key];
				if (val) {
					// map back the location to the value node so we can 
					// reference it later
					state.node_map[JSON.stringify(node.start)]=val;
					state.node_map[JSON.stringify(node.name.start)]=val;
					state.var_map[node.name.name] = val;
				}
			}
		}
		else if (node instanceof Uglify.AST_Sub) {
			if (node.expression && node.expression.thedef && node.expression.thedef.orig) {
				var key = JSON.stringify(node.expression.thedef.orig[0].start),
					val = state.node_map[key];
				if (val && val.returnType) {
					var match = val.returnType.match(/^(void|float|int|uint|long|short|ushort|double|bool|char)\s\*$/);
					if (match) {
						var getter = 'Hyperloop_Memory_Get_'+match[1],
							setter = 'Hyperloop_Memory_Set_'+match[1];
						state.builtin_symbols = state.builtin_symbols || {};
						state.builtin_symbols[getter] = match[1];
						var call = new Uglify.AST_Call({
							args: [node.expression, node.property],
							expression: new Uglify.AST_SymbolRef({name:getter,start:node.start,end:node.end}),
							start: node.start
						});
						call.hyperloop = {type:'memory_getter', setter:setter, class:match[1]};
						return call;
					}
				}
			}
		}
		// When we're assigning to a property and the value is the name of an enum, let's cheat and replace it with the enum's actual value'
		else if (node instanceof Uglify.AST_SymbolRef) {
			var p = transformer.parent();
			if (p instanceof Uglify.AST_Assign) {
				// We want to replace the symbol with the enum value
				if (p.left.hyperloop && p.left.hyperloop.type==='getter') {
					var cls = p.left.hyperloop.class;
					var field = p.left.hyperloop.property.name;
					var prop = library.findProperty(state.metabase, cls, field);
					if (prop['type'].substring(0,5) == 'enum ') {
						var subtype = state.metabase.types[prop.subtype];
						var enumValue = subtype.types[node.name].value;
						return new Uglify.AST_Number({value: enumValue, start: node.start, end: node.end});
					}
				}
			}
		}
		else if (node instanceof Uglify.AST_Call) {

			// deal with special Hyperloop commands
			if (node.start.value === 'Hyperloop') {
				var dict = {},
					command = generateHyperloopCommand(node.expression, node, dict);
				if (command) {
					return compileCommand(options,state,library,arch,node,command,dict);
				}
			}
			// handle cast
			if (node.expression && node.expression.property === 'cast') {
				var cast_to = node.args[0].name||node.args[0].value;
				state.node_map[JSON.stringify(node.start)] = {class:cast_to,returnType:cast_to};
				var newnode = node.expression.expression;
				newnode.$start = node.start;
				return newnode;
			}

			var nodeRef = state.node_map[JSON.stringify(node.start)],
				is_var = false,
				varname = node.start.value;

			if (!nodeRef) {
				nodeRef = state.var_map[varname];
				is_var = true;
			}

			if (nodeRef) {
				var stack = toExpressionStack(node);

				// could be a cast, so set it if not class is set
				var className = (nodeRef.returnType||nodeRef.class).replace(/\*/g,'').trim();

				if (nodeRef.returnType && !nodeRef.metatype) {
					// if we have a returnType, then it's a cast of a variable
					is_var = true;
				}

				// if a variable, then just use a symbol reference
				// if a call, then re-write it into a function
				var call = is_var ? 
					new Uglify.AST_SymbolRef({
						name: varname,
						start: node.start
					}) : 
					new Uglify.AST_Call({
						args: stack[0].args || [],
						expression: stack[0].node,
						start: stack[0].node.start
					});

				log.error('className=',className);
				log.error(node.print_to_string())
				log.error('node=',stack[0].node.print_to_string().blue)
				log.error(stack.length,stack)
				log.error('nodeRef=',nodeRef)
				log.error('var=',node.start.value,is_var)

				var fn = jsgen.generateMethodName(className, stack[1].property),
					key = state.obfuscate ? jsgen.obfuscate(fn) : fn,
					fncode = key,
					args = [call].concat(stack[1].args);

				var call2 = new Uglify.AST_Call({
					args: args,
					start: node.start,
					expression: new Uglify.AST_SymbolRef({
						name: key,
						start: node.start
					})
				});

				var symbol = library.getInstanceMethodSymbol(state, className, stack[1].property, varname, fn, node, fail);
				state.symbols[key] = symbol;

				call2.hyperloop = {
					class: className, 
					method: symbol, 
					type: 'method', 
					metatype: 'instance'
				};

				state.node_map[JSON.stringify(node.start)] = symbol;

				return call2;
			}
			else {
				var name = node.expression.name;
				if (node.expression && name && !isBuiltinObject(name) && library.isValidSymbol(state, name)) {
					return generateFunctionCall(library, state, name, node);
				}
				else if (node.expression && node.expression.property) {

					if (node.expression.expression.hyperloop && node.expression.expression.hyperloop.method) {
						return generateMethodCall3(options, library, state, node.expression.expression.hyperloop, node);
					}

					name = node.expression.expression.name || node.expression.expression.print_to_string();
					var thedef = node.expression.thedef || node.expression.expression.thedef,
						undeclared = !thedef ? true : thedef && thedef.undeclared;
					if (undeclared && name && !isBuiltinObject(name) && library.isValidSymbol(state, name)) {
						return generateClassMethodCall(library, state, name, node.expression.property, node);
					}
					else if (node.expression.expression && node.expression.expression.thedef &&
							node.expression.expression.thedef.init &&
							node.expression.expression.thedef.init.expression) {
						startpos = node.expression.expression.start.pos; // start of our expression
						symdef = node.expression.expression.thedef.orig; // get the array of all definitions
						// find last definition before this expression
						ourdef = symdef[0]; // assume first definition by default
						symdef.forEach(function (item) {
							if (item.end.pos > ourdef.end.pos && item.end.pos < startpos) {
								ourdef = item;
							}
						});
						// look up the type for that definition
						lookup = state.node_map[JSON.stringify(ourdef.start)];
						if (!lookup) {
							lookup = state.node_map[JSON.stringify(ourdef.thedef.init.start)];
						}
						if (lookup) {
							name = (lookup.type === 'constructor') ? lookup['class'] : lookup['returnType'];
							// If the returntype is id, we may want to cheat and assume the return type is the class
							if (name == 'id') {
								name = lookup['class'];
							}
							name = name.replace('*','').trim(); // FIXME Use typelib to sanitize pointers like this!
							if (name && !isBuiltinObject(name) && library.isValidSymbol(state, name)) {
								return generateMethodCall2(library, state, name, node);
							}
							if (node.expression.expression.thedef.init.expression.expression) {
								name = node.expression.expression.thedef.init.expression.expression.name;
								if (name && !isBuiltinObject(name) && library.isValidSymbol(state, name)) {
									return generateMethodCall2(library, state, name, node);
								}
							}
						}
					}		
					if (node.expression) {
						var methodName = node.expression.print_to_string(),
							prop = node.expression.property,
							cls = methodName.replace('.'+prop,'');
						if (undeclared && !isBuiltinObject(cls) && library.isValidSymbol(state,cls)) {
							return generateClassMethodCall(library, state, cls, methodName, node);
						}
					}
				}
				if (node.expression && node.expression.thedef && node.expression.thedef.undeclared){
					if (!isJSBuiltinObject(name)) {
						fail(node, name.yellow+" is an undefined symbol");
					}
				}
				if (node.expression && node.expression.property && node.expression.expression) {
					var key = node.expression.expression.thedef &&
							  node.expression.expression.thedef.orig[0].start ||
							  node.expression.expression.$start;
					var val = state.node_map[JSON.stringify(key)];
					if (val && key.value !== 'Hyperloop') {
						var cls = val.returnType,
							property = node.expression.property;
						return generateMethodCall2(library, state, cls, node);
					}
					if (node.expression.expression.thedef) {
						var name = node.expression.expression.name,
							isHLCommand = name==='Hyperloop';
						if (node.expression.expression.thedef.undeclared && !isHLCommand) {
							if (!isBuiltinObject(name)) {
								fail(node, name.yellow+" is an undefined symbol");
							}
						}
					}
				}
			}
		}
	});

	var result = ast.transform(transformer);

	// clean this up, no longer necessary after the transform
	delete state.node_map;

	return result;
}

function compress (ast, build_opts, filename, target, options, state) {
	var compressor = Uglify.Compressor({
			global_defs: build_opts,
			warnings: false,
			unused: false, // don't turn on, this will cause too many sideaffects
			dead_code: true,
			join_vars: true,
			properties: true,
			sequences: true,
			conditionals: true,
			comparisons: true,
			evaluate: true,
			booleans: true,
			loops: true,
			hoist_funs: true,
			hoist_vars: true,
			if_return: true,
			join_vars: true,
			cascade: true,
			drop_debugger: !!build_opts.ENV_PROD
		}),
		source_map = Uglify.SourceMap({
			file: target
		}),
		stream = Uglify.OutputStream({
			source_map: source_map,
			beautify: false
		}),
		stream2 = Uglify.OutputStream({
			source_map: source_map,
			beautify: !!build_opts.ENV_PROD || build_opts.DEBUG
		});

	ast.figure_out_scope();
	ast = ast.transform(compressor);

	// we are going to walk through our generated symbols and 
	// remove any unused variables not found in the source code
	var code = ast.print_to_string();
	log.debug('Symbols generated',Object.keys(state.symbols).join(', '));
	Object.keys(state.symbols).forEach(function(sym){
		if (code.indexOf(sym)===-1) {
			log.debug('detected unused symbol',sym,'('+state.symbols[sym].symbolname+')',',removing...');
			delete state.symbols[sym];
		}
	});

	ast.print(stream);
	ast.print(stream2);

	var retObj = {
		code: stream2.toString(),
		inlinecode: stream.toString(),
		map: source_map.toString(),
		ast: ast
	};

	printTraceInfo(filename, target, retObj);

	return retObj;
}

function generateNewConstructor(library, state, name, node) {
	var fn,
		key,
		symbol = library.getConstructorSymbol(state,name,node,fail);
	fn = symbol.symbolname;
	key = state.obfuscate ? jsgen.obfuscate(fn) : fn,
	state.symbols[key] = symbol;
	state.node_map[JSON.stringify(node.start)] = state.symbols[key];

	// save constructor information to make it easy to search later on
	state.constructors = state.constructors || {};
	state.constructors[name] = state.constructors[name] || {};
	state.constructors[name][key] = state.symbols[key];

	node.expression.name = key;
	return new Uglify.AST_Call({
		args: node.args,
		start: node.start,
		expression: new Uglify.AST_SymbolRef({
			name:key,
			start: node.start
		})
	});
}


function generateMethodCall(library, state, name, node) {
	var varname = node.start.value,
		expr = node.body.expression.property,
		fn = jsgen.generateMethodName(name, expr),
		key = state.obfuscate ? jsgen.obfuscate(fn) : fn,
		symbol;
		//TODO: move this into library
	state.symbols[key] = symbol = {type:'method',metatype:'instance',symbolname:fn,instance:varname,class:name,name:expr,location:node.start,argcount:node.body.args.length};
	state.node_map[JSON.stringify(node.start)] = symbol;
	node.body.args.unshift(new Uglify.AST_SymbolFunarg({name:varname, start:node.start}));
	node.body.expression = new Uglify.AST_SymbolRef({name:key, start: node.start});

	return node;
}

function generateMethodCall2(library, state, name, node) {
	var varname = node.start.value,
		expr = node.expression.property,
		fn = jsgen.generateMethodName(name, expr),
		symbol = library.getInstanceMethodSymbol(state,name,expr,varname,fn,node,fail),
		key = state.obfuscate ? jsgen.obfuscate(fn) : fn;
	state.symbols[key] = symbol;
	state.node_map[JSON.stringify(node.start)] = symbol;
	node.args.unshift(new Uglify.AST_SymbolFunarg({name:varname}));
	node.expression = new Uglify.AST_SymbolRef({name:key});

	node.hyperloop = {class:name, method:symbol, type:'method', metatype:'instance'};

	return node;
}

function generateMethodCall3(options, library, state, methodinfo, node){
	var varname = node.start.value,
		expr = node.expression.property,
		name = typelib.resolveType(methodinfo.method.method.returnType).toName(),
		fn = jsgen.generateMethodName(name, expr),
		symbol = library.getInstanceMethodSymbol(state,name,expr,varname,fn,node,fail),
		key = state.obfuscate ? jsgen.obfuscate(fn) : fn;
	state.symbols[key] = symbol;
	state.node_map[JSON.stringify(node.start)] = symbol;
	node.args.unshift(node.expression.expression);
	node.expression = new Uglify.AST_SymbolRef({name:key});

	node.hyperloop = {class:name, method:symbol, type:'method', metatype:'instance'};

	return node;
}

function generateClassMethodCall(library, state, cls, name, node) {
	var varname = node.start.value,
		fn = jsgen.generateMethodName(cls, name),
		symbol = library.getStaticMethodSymbol(state,cls,name,fn,node,fail),
		key = state.obfuscate ? jsgen.obfuscate(fn) : fn;
	state.symbols[key] = symbol;
	state.node_map[JSON.stringify(node.start)] = symbol;
	node.expression = new Uglify.AST_SymbolRef({name:key});	
	return node;
}

function generateFunctionCall(library, state, name, node) {
	var fn = jsgen.generateFunctionCallName(name),
		symbol = library.getFunctionSymbol(state,name,fn,node,fail),
		key = state.obfuscate ? jsgen.obfuscate(fn) : fn;
	node.expression.name = key;
	node.expression.start.value = key;
	node.expression.end.value = key;
	node.expression.thedef.name = key;
	state.symbols[key] = symbol;
	state.node_map[JSON.stringify(node.start)] = symbol;
	return node;
}

function generateStaticGetter(library, state, classname, property, node) {
	var fn = jsgen.generateGetterName(classname, property.name),
		key = state.obfuscate ? jsgen.obfuscate(fn) : fn,
		symbol = library.getGetterSymbol(state,classname,property.name,null,fn,node,fail);

	state.symbols[key] = symbol;
	state.node_map[JSON.stringify(node.start)] = symbol;

	var body = new Uglify.AST_Call({
		args: [],
		start: node.start,
		expression: new Uglify.AST_SymbolRef({name:key})
	});

	body.hyperloop = {class:classname, property:property, type:'getter', metatype:'static'};

	return body;
}

function generateGetterCall(library, state, classname, property, instance, node) {
	var fn = jsgen.generateGetterName(classname, property.name),
		key = state.obfuscate ? jsgen.obfuscate(fn) : fn,
		symbol = library.getGetterSymbol(state,classname,property.name,null,fn,node,fail);

	state.symbols[key] = symbol;
	state.node_map[JSON.stringify(node.start)] = symbol;

	var body = new Uglify.AST_Call({
		args: [
			instance
		],
		start: node.start,
		expression: new Uglify.AST_SymbolRef({name:key})
	});

	body.hyperloop = {class:classname, property:property, instance:instance, type:'getter', metatype:'instance'};

	return body;
}

function generateSetterCall(library, state, classname, property, instance, value, node) {
	var fn = jsgen.generateSetterName(classname, property),
		key = state.obfuscate ? jsgen.obfuscate(fn) : fn,
		symbol = library.getSetterSymbol(state,classname,property,null,fn,node,fail),
		body;

	state.symbols[key] = symbol;
	state.node_map[JSON.stringify(node.start)] = symbol;

	body = new Uglify.AST_Call({
		args: [ instance, value ],
		start: node.start,
		expression: new Uglify.AST_SymbolRef({name:key})
	});
	body.hyperloop = {class:classname, property:property, instance:instance, type:'setter', metatype:'instance'};

	return body;
}

/**
 * Function used to debug compiler output
 */
function printTraceInfo(filename, target, retObj) {
	log.trace('SOURCE: ' + filename);
	log.trace('TARGET: ' + target);
	log.trace('CODE:\n' + retObj.code);
	log.trace('MAP:\n' + retObj.map);
	log.trace('');
}

/**
 * called when a compiler command is received
 */
function compileCommand(options, state,library,arch,node,command,dict) {
	switch (command) {
		case 'defineClass': {
			if (dict.build) {
				var result = library.defineClass(options,state,arch,node,dict,fail),
					elements = result.args.map(function(arg){
						return new Uglify.AST_Call({
							args: [
								new Uglify.AST_SymbolFunarg({name:arg.action})
							],
							expression: new Uglify.AST_SymbolRef({name:arg.function})
						});
					});
				return new Uglify.AST_Array({elements:elements});
			} else {
				return;
			}
		}
		case 'method': {
			if (dict.call) {
				if (dict.method.length < 2) {
					fail(node, "hyperloop method `call` command requires at least two arguments: (1) class/instance reference and (2) method");
				}
				var result = library.defineMethod(options,state,arch,node,dict,fail);
				var args = result.args.map(function(c) {
					return hyperloopNodeToUglifyNode(c);
				});
				return new Uglify.AST_Call({start:result.start, args:args, expression:new Uglify.AST_SymbolRef({name:result.name})});
			} 
			else {
				return;
			}
		}
		default: {
			fail(node,"hyperloop command: "+command+" not supported");
		}
	}
}
