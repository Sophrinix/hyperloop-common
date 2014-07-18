/**
 * library generation
 */
var fs = require('fs'),
	path = require('path'),
	wrench = require('wrench'),
	crypto = require('crypto'),
	_ = require('underscore'),
	log = require('../log'),
	util = require('../util'),
	jsgen = require('./jsgen'),
	typelib = require('./type'),
	HEADER = util.HEADER;

exports.generateLibrary = generateLibrary;
exports.getArchitectures = getArchitectures;
exports.prepareArchitecture = prepareArchitecture;
exports.generateBuiltinClasses = generateBuiltinClasses;
exports.writeSourceFile = writeSourceFile;
exports.loadSourceCache = loadSourceCache;
exports.saveSourceCache = saveSourceCache;
exports.generateCodeDependencies = generateCodeDependencies;
exports.generateCode = generateCode;


// for testing
exports.compileType = compileType;

function getArchitectures(options, callback) {
	loadLibrary(options).getArchitectures(options, callback);
}

function prepareArchitecture (options, arch, details, settings, callback) {
	loadLibrary(options).prepareArchitecture(options, arch, details, settings, callback);
}

function loadLibrary(options) {
	// we are going to load the platform library from the platform dir
	var platform_lib = path.join(options.platform_dir, 'lib', 'library.js');
	if (!fs.existsSync(platform_lib)) {
		throw new Error("Couldn't find platform library at "+platform_lib);
	}
	var library = require(platform_lib);
	return library;
}

/**
 * load in the source cache file
 */
function loadSourceCache (options) {
	var hash = util.sha1(JSON.stringify(options));
	options.srcCacheFn = path.join(options.srcdir,'srccache.json')
	options.compilerSrcCache = {};
	if (!fs.existsSync(options.srcdir)) {
		wrench.mkdirSyncRecursive(options.srcdir);
	}
	else {
		fs.existsSync(options.srcCacheFn) && (options.compilerSrcCache = JSON.parse(fs.readFileSync(options.srcCacheFn,'utf8')));
		log.trace('generating source cache hashes (options,file)=>',hash,options.compilerSrcCache.hash)
		if (options.compilerSrcCache && options.compilerSrcCache.hash!=hash) {
			log.info('reset compiler cache because options have changed. forcing a rebuild');
			options.compilerSrcCache = {};
		}
		options.compilerSrcCache.hash = hash;
	}
}

/**
 * save our source cache file
 */
function saveSourceCache (options) {
	log.trace('saving',options.compilerSrcCache)
	fs.writeFileSync(options.srcCacheFn, JSON.stringify(options.compilerSrcCache,null,3),'utf8');
}

/**
 * called to generate a pre-compiled native metabase library
 */
function generateLibrary(options, callback) {

	log.info('Generating library');

	var library = loadLibrary(options);

	// set the global platform in the typelib
	typelib.platform = options.platform_dir;

	// put the files as a child directory of the destination dir
	options.srcdir = path.join(options.dest,'src');
	var outdir = options.outdir = path.join(options.dest,'build');

	if (!fs.existsSync(options.srcdir)) {
		wrench.mkdirSyncRecursive(options.srcdir);
	}
	if (!fs.existsSync(options.outdir)) {
		wrench.mkdirSyncRecursive(options.outdir);
	}

	// by default, this is the hyperloop library
	options.libname = options.libname || library.getDefaultLibraryName();

	var header_name = 'hyperloop' + library.getFileExtension(true)
		header = path.join(options.dest, header_name),
		header_dir = options.dest;

	// if we already have a header, make sure we regenerate since we have dynamic headers/source
	if (fs.existsSync(header)){
		fs.unlinkSync(header);
		if (fs.existsSync(options.srcdir)) {
			wrench.rmdirSyncRecursive(options.srcdir);
		}
	}
	
	function proceed () {
		
		// delete any files that already exist
		util.filelisting(options.dest,/\.(a|so|dylib|dll|lib)$/).forEach(fs.unlinkSync);
		
		// start the generation and compilation
		library.prepareLibrary(options,function(err, archs, details, settings) {
			if (err) return callback(err);
			var i = 0,
				arch_results = {};
			(function nextArch() {
				var arch = archs[i++];
				if (arch) {
					// put the files as a child directory of the destination dir
					options.srcdir = path.join(options.dest,'src',arch);
					options.outdir = path.join(outdir,arch);
					loadSourceCache(options);
					// generate for each architecture
					library.prepareArchitecture(options, arch, details, settings, function(err, metabase) {
						if (err) return callback(err);
						// file which we are going to compile
						options.srcfiles = [];
						options.arch = arch;
						// set the metabase
						typelib.metabase = metabase;
						// reset to remove any cached types since we're changing metabase
						typelib.reset();
						generateBuiltinClasses(options, arch, metabase, library);
						// save our source cache
						saveSourceCache(options);
						library.compileLibrary(options, arch, metabase, function(err, libfile){
							if (err) return callback(err);
							arch_results[arch] = libfile;
							nextArch();
						});
					});
				}
				else {
					library.generateLibrary(options, arch_results, settings, callback);

					// write out the symbol map for the library
					var symmap = jsgen.getSymbolMap();
					fs.writeFileSync(path.join(options.dest,'library_symbols.json'),JSON.stringify(symmap,null,'\t'),'utf8');
				}
			})();
		});
	}

	// allow the library to validate options
	library.validateOptions ? library.validateOptions(options, proceed) : proceed();
}

/**
 * called to copy any built-in classes to the src directory
 */
function generateBuiltinClasses(options, arch, metabase, library, header_only) {
	var basedir = path.join(__dirname,'..','..','templates'), // common code templates
		// platform specific code templates
		platform_basedir = path.join(options.platform_dir,'templates'),
		header_name = 'hyperloop' + library.getFileExtension(true),
		files = fs.readdirSync(basedir).filter(function(f){return f.indexOf(header_name)==-1}).map(function(f) { return path.join(basedir, f) }),
		platform_files = fs.existsSync(platform_basedir) ? fs.readdirSync(platform_basedir).map(function(f){ return path.join(platform_basedir,f) }) : [],
		header = path.join(basedir, header_name),
		hyperloopHeader = path.join(options.headerdir, header_name),
		impls = [],
		headerCreated = fs.existsSync(hyperloopHeader);

	!headerCreated && util.copyFileSync(path.join(basedir, header_name), hyperloopHeader);

	files = files.concat(platform_files);

	// we are going to group _ headers in sorted order before non _ files
	var agroup = files.filter(function(f) { return path.basename(f).charAt(0)==='_'; }),
		bgroup = files.filter(function(f) { return path.basename(f).charAt(0)!=='_'; });

	// prefer underscores first before real headers. this allows us to order things 
	// that need to be loaded before others
	function sorter(a,b) {
		var a1 = path.basename(a).charAt(0),
			b1 = path.basename(b).charAt(1);
		if (a1==b1) return 0;
		if (a1=='_') return -1;
		return 1;
	}
	// only sort the _ files, not the others so we can preserve order between common and platform
	var sorted = agroup.sort(sorter).concat(bgroup).filter(function(fn){
		return !util.isDirectory(fn) && !/^\.(DS_Store|git|svn|cvs)/.test(path.basename(fn));
	});

	sorted.forEach(function(fn){
		var ext = path.extname(fn),
			basename = path.basename(fn),
			base = basename.replace(ext,''),
			header = ext=='.h',
			prepend = basename.charAt(0)==='_',
			destfn = path.join(header ? options.headerdir : options.srcdir, base + library.getFileExtension(header)),
			is_platform = fn.indexOf(platform_basedir)==0,
			exists = fs.existsSync(destfn),
			hlfn = hyperloopHeader;

		// copy the files into the source directory, correctly setting the file extensions
		// for the platform. this allows us to use a generic file extension and have it 
		// correctly set when the files are copied (for example changing .cpp -> .m on ios)
		if (header && !headerCreated) {
			// we always merge all headers to the main hyperloop.h so we only need
			// to distribute one file
			prepend ? util.prependFileSync(fn,hlfn) : util.appendFileSync(fn, hlfn);
		}
		else if (!header_only && !header) {
			if (is_platform && exists) {
				util.appendFileSync(fn, destfn);
			}
			else {
				var content = fs.readFileSync(fn,'utf8').toString();
				options.obfuscate && (impls.push(content));
				writeSourceFile(options, library, destfn, content, true);
			}
		}
	});

	// we are going to obfuscate our exported APIs such that the final compiled
	// code will have randomized function names.  from a dev standpoint, the 
	// developer still uses the export API name but the compiler will turn that 
	// name into the obfuscated name during compilation
	if (options.obfuscate && !headerCreated) {
		var exportRegEx = /EXPORTAPI\s+(.*)?\s+(\w+)\s*\(/,
			exportFPRegEx = /typedef\s+(\w+)\s+\(\*(.*)?\)\s*\(/,
			staticRegEx = /static\s+(.*)?\s+(\w+)\s*\(/,
			renameWords = ['Appcelerator','Hyperloop','Titanium'],
			renameListRegEx = new RegExp('('+renameWords.join('|')+')','i'),
			exportedAPIS = {'HyperloopAppRequire':1},
			content = fs.readFileSync(hyperloopHeader,'utf8').toString();

		function extractSymbols(fcontents) {
			fcontents.split('\n').forEach(function(line){
				// log.debug('testing',line)
				line = line.trim();
				var fn;
				if (line && exportRegEx.test(line)) {
					var m = exportRegEx.exec(line);
					fn = m[2];
				}
				else if (line && staticRegEx.test(line)) {
					var m = staticRegEx.exec(line);
					fn = renameListRegEx.test(m[2]) && m[2];
				}
				else if (line && exportFPRegEx.test(line)) {
					var m = exportFPRegEx.exec(line);
					fn = m[2];
				}
				if (fn && !(fn in exportedAPIS)) {
					exportedAPIS[fn]=1;
				}
			});
		}

		// extract symbols from hyperloop.h
		extractSymbols(content);

		// extract additional symbols from each implementation
		impls.forEach(function(icontent){
			extractSymbols(icontent);
		});

		var defines = '// rename our common symbols for obfuscation. these are generated library build\n' +
			Object.keys(exportedAPIS)
				.concat(renameWords)
				.map(function(k){
					return '#define '+k+' '+jsgen.obfuscate(k,'HL_');
				})
				.join('\n') + '\n';

		// insert after the first comment block
		var idx = content.indexOf('*/');
		if (idx > 0) {
			content = content.substring(0,idx+2) + '\n\n' + defines + content.substring(idx+2);
		}
		else {
			content = defines + content;
		}
		fs.writeFileSync(hyperloopHeader,content,'utf8');
	}
}

/**
 * generate code for all functions
 */
function generateFunctions(options, state, metabase, library, functions) {
	var code = [HEADER],
		fncode = [];

	// generate header details
	code.push(util.multilineComment('Hyperloop functions library'));
	code.push('');
	code.push('#include <hyperloop.h>');
	code.push('');

	// let the library do it's own includes
	library.prepareIncludes && library.prepareIncludes(options,metabase,state,code);
	
	code.push('#ifdef __cplusplus');
	code.push('extern "C" {');
	code.push('#endif');

	library.prepareFunctions && library.prepareFunctions(options,state,metabase,library,code);

	functions.forEach(function (fn) {
		// resolve the return type
		typelib.resolveType(fn.returnType);
		library.prepareFunction && library.prepareFunction(options,metabase,state,fn.name,code);
		// generate the function
		compileFunction(options, metabase, state, library, fn.name, fn, fncode);
	});

	if (fncode.length) {

		// this must be called before processing
		library.prepareHeader(options, metabase, state, '', code);

		// append function body code
		code = code.concat(fncode);

		// this must be called after processing
		library.prepareFooter(options, metabase, state, '', code);

		code.push('#ifdef __cplusplus');
		code.push('}');
		code.push('#endif');

		// determine the filename
		var outfn = path.join(options.srcdir, library.getFunctionsFilename(options, metabase, state));

		// write source file if required
		writeSourceFile(options,library,outfn,code);
	}
}

/**
 * generate code for all types
 */
function generateTypes(options, metabase, library) {
	var types = typelib.types, // get all the dependent types
		code = [HEADER],
		typecode = [],
		state = {};


	// generate header details
	code.push(util.multilineComment('Hyperloop types library'));
	code.push('');
	code.push('#include <hyperloop.h>');
	
	library.prepareIncludes && library.prepareIncludes(options,metabase,state,code);
	
	code.push('#ifdef __cplusplus');
	code.push('extern "C" {');
	code.push('#endif');

	if (library.shouldCompileTypes && !library.shouldCompileTypes()) {
		return;
	}
	library.prepareTypes && library.prepareTypes(options,state,metabase,library,code);

	types.forEach(function (typename) {
		var typeobj = typelib.resolveType(typename);
		if (typeobj.isNativeNull() || typeobj.isNativeVoid() || typeobj.isNativePrimitive()
			 || typeobj.isNativeString() || typeobj._void || typeobj.isNativeBoolean() || typeobj.isNativePointer()) {
			return;
		}
		var type = library.prepareType(options, metabase, state, typename);
		if (typeobj.isNativeFunctionPointer() || type) {
			// generate the type
			compileType(options, metabase, state, library, typename, type, typecode);
		}
	});

	if (typecode.length) {
		// this must be called before processing
		library.prepareHeader(options, metabase, state, '', code);

		// append function body code
		code = code.concat(typecode);

		// this must be called after processing
		library.prepareFooter(options, metabase, state, '', code);

		code.push('#ifdef __cplusplus');
		code.push('}');
		code.push('#endif');

		// determine the filename
		var outfn = path.join(options.srcdir, library.getTypesFilename(options, metabase, state));

		// write source file if required
		writeSourceFile(options,library,outfn,code);
	}
}

/**
 * generate a function body code
 */
function compileFunction(options, metabase, state, library, fnname, fn, code) {
	var gen = library.generateFunction(options, metabase, state, '\t', fnname, fn);
	code.push(util.multilineComment('function: '+fnname));
	code.push('EXPORTAPI JSValueRef '+fnname+'_function(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argumentCount, const JSValueRef arguments[], JSValueRef* exception)');
	code.push('{');
	code.push(gen);
	code.push('}');	
	code.push('');
	fn.arguments.forEach(function(arg,index){
		var type = arg.type||arg.subtype||arg.name;
		if (!type) {
			throw new Error("couldn't determine argument["+index+"] type for function: "+fnname,arg);
		}
		typelib.resolveType(type);
	});
}

/**
 * generate a type body code
 */
function compileType(options, metabase, state, library, typename, type, code) {
	var typeobj = typelib.resolveType(typename),
		name = typeobj.getAsKey();

	// to keep track of one's generated since we format types (such as enum Foo -> Foo) and
	// we need to make that we don't generate two for both (enum and non enum prefixes)
	if (!state.types) {
		state.types = {};
	}
	if (name in state.types) {
		log.debug("ignoring already generated type",name);
		return;
	}
	if (typeobj.isNativeObject()) {
		// objects already have their own conversion functions
		return;
	}
	if (typeobj.isNativeFunctionPointer()) {
		code.push(util.multilineComment('callback for '+typename));
		var gen = typeobj.toNativeFunctionCallback(name);
		code.push(gen);
		code.push('');
	}
	state.types[name]=1;
	var cast = typeobj.toCast(),
		isObject = typeobj.isNativeFunctionPointer() ||
					typeobj.isNativePointer() || typeobj.isNativeStruct() || 
					typeobj.isNativeBlock() || typeobj.isNativeUnion(),
		preamble = [], 
		cleanup = [],
		declare = [],
		body = [];

	isObject && body.push(typeobj.toDeclaration());

	body.push(util.multilineComment('type: '+typename+' to JSValueRef'));
	body.push('EXPORTAPI JSValueRef '+typeobj.toJSValueName()+'(JSContextRef ctx, '+cast+' value, JSValueRef *exception)');
	body.push('{');

	//TODO: review this -- maybe move this back into type.js?
	if (!isObject) {
			gen = typeobj.toJSBody('value',preamble,cleanup,declare);
			preamble.length && preamble.forEach(function(c){body.push('\t'+c)});
			body.push('\tauto result$ = '+gen+';');
			cleanup.length && cleanup.forEach(function(c){body.push('\t'+c)});
			body.push('\treturn result$;');
			declare.length && declare.forEach(function(c){code.push(c)});
	}
	else {
		body.push('\treturn JSObjectMake(ctx,Register'+typeobj.toName()+'(),new Hyperloop::NativeObject<'+cast+'>(value));');
	}
	body.push('}');	
	body.push('');

	body.push(util.multilineComment('type: '+typename+' from JSValueRef'));
	body.push('EXPORTAPI '+cast+' '+typeobj.toNativeName()+'(JSContextRef ctx, JSValueRef value, JSValueRef *exception)');
	body.push('{');
	if (!isObject) {
		preamble.length && (preamble=[]);
		cleanup.length && (cleanup=[]);
		declare.length && (declare=[]);
		gen = typeobj.toNativeBody('value',preamble,cleanup,declare);
		preamble.length && preamble.forEach(function(c){body.push('\t'+c)});
		body.push('\tauto result$ = static_cast<'+cast+'>('+gen+');');
		cleanup.length && cleanup.forEach(function(c){body.push('\t'+c)});
		body.push('\treturn result$;');
		declare.length && declare.forEach(function(c){code.push(c)});
	}
	else {
		body.push('\tauto p = JSObjectGetPrivate(JSValueToObject(ctx,value,exception));');
		body.push('\tauto po = reinterpret_cast<Native'+typeobj.toName()+'>(p);');
		body.push('\treturn po->getObject();');
	}
	body.push('}');	
	body.push('');

	code.push(body.join('\n'));
}

/**
 * generate a method body code
 */
function compileMethod(options, metabase, state, library, classname, methodname, methods, code) {

	var methods = Array.isArray(methods) ? methods : [methods],
		typeobj = typelib.resolveType(classname),
		cast = typeobj.toCast(),
		mangledClassname = jsgen.sanitizeClassName(classname),
		indent = '\t';

	methods.forEach(function(method) {
		var instance = library.isMethodInstance(options, metabase, state, method),
			ig = library.prepareMethod(options,metabase,state,classname,methodname,methods,code),
			varname = instance ? mangledClassname.toLowerCase() : mangledClassname,
			signature = library.getMethodSignature(options, metabase, state, classname, methodname, method),
			gen = library.generateMethod(options, metabase, state, indent, varname, classname, method, methodname),
			fn = jsgen.generateMethodName(classname, methodname)+(methods.length > 1 ? signature : ''),
			ig = typelib.resolveType(method.returnType);

		code.push(util.multilineComment('method: '+(method.selector||method.signature||method.name)));
		code.push('EXPORTAPI JSValueRef '+fn+'(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argumentCount, const JSValueRef arguments[], JSValueRef* exception)');
		code.push('{');
		if (instance) {
			code.push(indent+'auto '+varname+' = ToNativeObject(JSValueToObject(ctx,arguments[0],exception));');
			code.push(indent+'if ('+varname+' == nullptr)');
			code.push(indent+'{');
			code.push(indent+'\t*exception = HyperloopMakeException(ctx,"couldn\'t convert object to '+classname+'");');
			code.push(indent+'\treturn JSValueMakeUndefined(ctx);');
			code.push(indent+'}');
		}
		code.push(gen);
		code.push('}');
		code.push('');

		method.args.forEach(function(arg){
			typelib.resolveType(arg.type);
		});

	});
}

/**
 * generate a property body code
 */
function compileProperty(options, metabase, state, library, classname, propertyname, property, code, isGetter) {

	var typeobj = typelib.resolveType(classname),
		cast = typeobj.toCast(),
		varname = jsgen.sanitizeClassName(classname).toLowerCase(),
		instance = library.isPropertyInstance(options, metabase, state, property),
		indent = '\t',
		ig = library.prepareProperty(options,metabase,state,classname,propertyname,property,code,isGetter);

	if (isGetter) {
		var fn = jsgen.generateGetterName(classname, propertyname);
		code.push(util.multilineComment('property getter: '+propertyname));
		code.push('EXPORTAPI JSValueRef '+fn+'(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argumentCount, const JSValueRef arguments[], JSValueRef* exception)');
		code.push('{');
		code.push('\tJSValueRef result = nullptr;');
		if (instance) {
			code.push(indent+'auto '+varname+' = ToNativeObject(JSValueToObject(ctx,arguments[0],exception));');
			code.push(indent+'if ('+varname+' == nullptr)');
			code.push(indent+'{');
			code.push(indent+'\t*exception = HyperloopMakeException(ctx,"couldn\'t convert object to '+classname+'");');
			code.push(indent+'\treturn JSValueMakeUndefined(ctx);');
			code.push(indent+'}');
		}
		var gen = library.generateGetterProperty(options, metabase, state, library, classname, propertyname, property, varname, cast, indent);
		code.push(gen);
		code.push('\treturn result;');
		code.push('}');	
		code.push('');
	}
	else {
		var fn = jsgen.generateSetterName(classname, propertyname);
		code.push(util.multilineComment('property setter: '+propertyname));
		code.push('EXPORTAPI JSValueRef '+fn+'(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argumentCount, const JSValueRef arguments[], JSValueRef* exception)');
		code.push('{');
		code.push('\tJSValueRef result = nullptr;');
		if (instance) {
			code.push(indent+'auto '+varname+' = ToNativeObject(JSValueToObject(ctx,arguments[0],exception));');
			code.push(indent+'if ('+varname+' == nullptr)');
			code.push(indent+'{');
			code.push(indent+'\t*exception = HyperloopMakeException(ctx,"couldn\'t convert object to '+classname+'");');
			code.push(indent+'\treturn JSValueMakeUndefined(ctx);');
			code.push(indent+'}');
			code.push(indent+'auto value = arguments[1];');
		} else {
			code.push(indent+'auto value = arguments[0];');
		}
		var gen = library.generateSetterProperty(options, metabase, state, library, classname, propertyname, property, varname, cast, indent);
		code.push(gen);
		code.push('\treturn result;');
		code.push('}');	
		code.push('');
	}
}

/**
 * class to hold each compile unit
 */
function SourceEntry(options, library, outfn, code) {
	this.srcfile = outfn;
	this.objfile = path.join(options.outdir,path.basename(outfn)).replace(path.extname(outfn),library.getObjectFileExtension(false));
	this.compile = /\.(cpp|m|mm|c)$/.test(path.extname(outfn)); // only compile C/C++ files
	this.hash = crypto.createHash('md5').update(code).digest('hex');
	options.srcfiles.push(this);
	// if not on disk, remove it
	if (!fs.existsSync(this.objfile) && (outfn in options.compilerSrcCache)) {
		delete options.compilerSrcCache[outfn];
	}
}

/**
 * check the compiler source cache and return true if the same as the code
 * we have generated
 */
function writeSourceFile(options, library, outfn, code, write) {

	var srccode = Array.isArray(code) ? code.join('\n') : code,
		entry = new SourceEntry(options, library, outfn, srccode);

	// --skip-codegen option skips overwriting existing file
	if (!write && fs.existsSync(outfn) && options['skip-codegen']) {
		var hashB = crypto.createHash('md5').update(fs.readFileSync(outfn,'utf8').toString()).digest('hex');
		if (entry.hash==hashB) {
			entry.compile = false;
		} else {
			options.compilerSrcCache[outfn] = hashB;
		}
		return;
	}

	// write our output
	write && !fs.existsSync(outfn) && (write=true) && fs.writeFileSync(outfn, srccode, 'utf8');

	// don't re-write same files unless force compile
	if (fs.existsSync(outfn) && !options.force) {
		if (outfn in options.compilerSrcCache) {
			var hashB = crypto.createHash('md5').update(fs.readFileSync(outfn,'utf8').toString()).digest('hex');
			if (entry.hash==hashB) {
				log.debug('cached function source file from',outfn.cyan);
				entry.compile = false;
			}
		}
	}

	// remember the cache
	options.compilerSrcCache[outfn] = entry.hash;

	// only write if we are compiling
	if (entry.compile && !write) {
		// write out the content
		fs.writeFileSync(outfn, srccode, 'utf8');
		log.debug('wrote source file to',outfn.cyan);
	}

}

/**
 * generate dependent types found during processing
 */
function generateCodeDependentTypes(options,state,symboltable) {
	typelib.classes.forEach(function(_k){
		var k = typelib.resolveType(_k).toSafeClassName();
		if (!(k in symboltable.classmap)) {
			// we have detected a class dependency that we need to record
			symboltable.classmap[k] = {
				static_methods: {},
				instance_methods: {},
				getters: {},
				setters: {},
				constructors: {}
			};
		}
	});
}

/**
 * generate source code
 */
function generateCodeDependencies(options,state,symboltable,relativeFilename,arch,symbols,nodefail) {
	var classmap = symboltable.classmap || {},
		functions = symboltable.functions || {},
		variablemap = symboltable.variablemap && symboltable.variablemap[relativeFilename];
	if (!symboltable.classmap) {
		symboltable.classmap = classmap;
		symboltable.functions = functions;
	}
	if (!variablemap) {
		symboltable.variablemap = {};
		symboltable.variablemap[relativeFilename] = variablemap = {};
	}

	// custom class symbol should be added to symbol table even if it is never used
	state.custom_classes && Object.keys(state.custom_classes).forEach(function(c) {
		symboltable.classmap[c] = symboltable.classmap[c] ||  {
			static_methods: {},
			instance_methods: {},
			getters: {},
			setters: {},
			constructors: {}
		};
	});

	var metabase = state.metabase;

	function resolveTypes(returnType,args) {
		// resolve each arg
		args && args.length && args.forEach(function(arg){
			if (typeof(arg.type)!=='string') {
				arg.type = arg.type.value;
			}
			arg.type && typelib.resolveType(arg.type);
		});
		if (typeof(returnType)!=='string' && returnType.value) {
			returnType = returnType.value;
		} else if (returnType instanceof typelib.Class) {
			returnType = returnType.toName();
		}
		// resolve and return the result type
		return typelib.resolveType(returnType);
	}


	Object.keys(symbols).forEach(function(name){
		var symbol = symbols[name];
		switch (symbol.type) {
			case 'constructor': 
			case 'statement':
			case 'method': {
				var entry = classmap[symbol.class];
				if (!entry) {
					entry = {
						static_methods: {},
						instance_methods: {},
						getters: {},
						setters: {},
						constructors: {}
					};
					classmap[symbol.class] = entry;
				}
				if (name in variablemap) {
					variablemap[name].push(symbol.symbolname);
				}
				else {
					variablemap[name] = [symbol.symbolname];
				}


				switch (symbol.metatype) {
					case 'instance': {
						entry.instance_methods[symbol.symbolname] = symbol;
						var type = resolveTypes(symbol.returnType,symbol.method.args);
						if (type && type.isNativeObject()) {
							var typename = type.toName();
							classmap[typename] = classmap[typename] || {
								static_methods: {},
								instance_methods: {},
								getters: {},
								setters: {},
								constructors: {}
							};
						}
						break;
					}
					case 'static': {
						entry.static_methods[symbol.symbolname] = symbol;
						var type = resolveTypes(symbol.returnType,symbol.method.args);
						if (type && type.isNativeObject()) {
							var typename = type.toName();
							classmap[typename] = classmap[typename] || {
								static_methods: {},
								instance_methods: {},
								getters: {},
								setters: {},
								constructors: {}
							};
						}
						break;
					}
					case 'setter': {
						entry.setters[symbol.symbolname] = symbol;
						var type = resolveTypes(symbol.property.type);
						break;
					}
					case 'getter': {
						entry.getters[symbol.symbolname] = symbol;
						var type = resolveTypes(symbol.property.type);
						if (type && type.isNativeObject()) {
							var typename = type.toName();
							classmap[typename] = classmap[typename] || {
								static_methods: {},
								instance_methods: {},
								getters: {},
								setters: {},
								constructors: {}
							};
						}
						break;
					}
					case 'constructor': {
						// this is constructor
						var type = resolveTypes(symbol.class);
						entry.constructors[symbol.symbolname] = symbol;
						break;
					}
					default: {
						throw new Error("unknown metatype:"+symbol.type);
					}
				}
				break;
			}
			case 'function': {
				functions[name] = symbol;
				break;
			}
			default: {
				throw new Error("symbol of type: "+symbol.type+" not yet supported");
			}
		}
	});
}

/**
 * generate all dependent source code
 */
function generateCode(options,state,symboltable,arch,nodefail) {
	var library = loadLibrary(options),
		metabase = state.metabase;

	// generate any detected dependent types found during code processing
	generateCodeDependentTypes(options,state,symboltable);

	// set some required properties
	options.srcdir = path.join(options.dest,'src',arch);
	var outdir = options.outdir = path.join(options.dest,'build',arch);

	if (!fs.existsSync(options.srcdir)) {
		wrench.mkdirSyncRecursive(options.srcdir);
	}

	if (!fs.existsSync(options.outdir)) {
		wrench.mkdirSyncRecursive(options.outdir);
	}

	// load up our source code cache
	loadSourceCache(options);

	// file which we are going to compile
	options.srcfiles = [];

	if (symboltable.functions) {
		var functions = [];

		//TODO FIXME
		state.externs = [];

		Object.keys(symboltable.functions).forEach(function(e){ 
			var fn = symboltable.functions[e].function,
				found = functions.filter(function(f){return f.name === fn.name});
			if (!found.length) {
				functions.push(fn);
			}
		});

		generateFunctions(options, state, metabase, library, functions);
	}

	library.prepareClasses && library.prepareClasses(options, state, metabase, library, symboltable);

	if (symboltable.classmap) {
		var classes = {};

		Object.keys(symboltable.classmap).forEach(function(name){
			var symbol = symboltable.classmap[name],
				clscode = classes[name] || [],
				classname = name,
				typeobj = typelib.resolveType(classname),
				cast = typeobj.toCast(),
				basecast = typeobj.toBaseCast(),
				mangledClassname = jsgen.sanitizeClassName(classname),
				isClassLike = typeobj.isNativeObject() || typeobj.isNativeStruct() ||
							typeobj.isNativePointer() || typeobj.isNativeBlock() ||
							typeobj.isNativeFunctionPointer() || typeobj.isNativeUnion();

			if (typeobj.isJSUndefined() || typeobj.isJSNull()) {
				// skip non types
				return;
			}

			if (!clscode.length && isClassLike) {
				log.info('Generating class:',name.yellow.bold);
	
				classes[name] = clscode;
				
				var skip = library.prepareClass(options,metabase,state,name,clscode);
				if (skip) {
					return;
				}

				library.prepareIncludes && library.prepareIncludes(options,metabase,state,clscode);

				clscode.push('EXPORTAPI '+cast+' JSValueTo_'+mangledClassname+'(JSContextRef,JSValueRef,JSValueRef*);');
				clscode.push('');
				clscode.push('typedef Hyperloop::NativeObject<'+basecast+'> * Native'+mangledClassname+';');
				clscode.push('');
				clscode.push('static JSClassRef RegisterClass();');
				clscode.push('');

				clscode.push(util.multilineComment('internal method to return NativeObject'));
				clscode.push('static Native'+mangledClassname+' ToNative(JSObjectRef object)');
				clscode.push('{');
				clscode.push('\tauto p = JSObjectGetPrivate(object);')
				clscode.push('\treturn reinterpret_cast<Native'+mangledClassname+'>(p);')
				clscode.push('}');
				clscode.push('');

				clscode.push(util.multilineComment('internal method to return object'));
				clscode.push('static '+cast+' ToNativeObject(JSObjectRef object)');
				clscode.push('{');
				clscode.push('\tauto o = ToNative(object);');
				clscode.push('\tif (o == nullptr)');
				clscode.push('\t{');
				clscode.push('\t\treturn '+typeobj.toValueAtConversionFail()+';');
				clscode.push('\t}');
				clscode.push('\treturn '+typeobj.toNativeObject()+';');
				clscode.push('}');
				clscode.push('');

				clscode.push(util.multilineComment('called when object is created'));
				clscode.push('static void Initializer(JSContextRef context, JSObjectRef object)');
				clscode.push('{');
				clscode.push('\tToNative(object)->retain();');
				clscode.push('}');
				clscode.push('');

				clscode.push(util.multilineComment('called when object is destroyed'));
				clscode.push('static void Finalizer(JSObjectRef object)');
				clscode.push('{');
				clscode.push('\tToNative(object)->release();');
				clscode.push('}');
				clscode.push('');

				clscode.push(util.multilineComment('called when object is used in instanceof'));
				clscode.push('static bool HasInstance(JSContextRef ctx, JSObjectRef constructor, JSValueRef possibleInstance, JSValueRef* exception)');
				clscode.push('{');
				clscode.push('\treturn ToNative(constructor)->hasInstance(ctx,possibleInstance,exception);');
				clscode.push('}');
				clscode.push('');

				clscode.push(util.multilineComment('called when toString is invoked'));
				clscode.push('static JSValueRef ToString(JSContextRef ctx, JSObjectRef function, JSObjectRef object, size_t argumentCount, const JSValueRef arguments[], JSValueRef* exception)');
				clscode.push('{');
				clscode.push('\tauto o = ToNative(object);');
				clscode.push('\tauto str = o->toString(ctx,exception);');
				clscode.push('\tif (!str.empty())');
				clscode.push('\t{');
				clscode.push('\t\tauto strRef = JSStringCreateWithUTF8CString(str.c_str());');
				clscode.push('\t\tauto result = JSValueMakeString(ctx, strRef);');
				clscode.push('\t\tJSStringRelease(strRef);');
				clscode.push('\t\treturn result;');
				clscode.push('\t}');
				clscode.push('\telse');
				clscode.push('\t{');
				clscode.push('\t\treturn JSValueMakeNull(ctx);');
				clscode.push('\t}');
				clscode.push('}');
				clscode.push('');

				clscode.push(util.multilineComment('called when toString is invoked (from JS)'));
				clscode.push('EXPORTAPI JSValueRef '+mangledClassname+'_toString(JSContextRef ctx, JSObjectRef function, JSObjectRef object, size_t argumentCount, const JSValueRef arguments[], JSValueRef* exception)');
				clscode.push('{');
				clscode.push('\treturn ToString(ctx,0,JSValueToObject(ctx,arguments[0],exception),0,0,exception);');
				clscode.push('}');
				clscode.push('');

				clscode.push(util.multilineComment('called when conversion of one JS type to another'));
				clscode.push('static JSValueRef ConvertTo(JSContextRef ctx, JSObjectRef object, JSType type, JSValueRef* exception)');
				clscode.push('{');
				clscode.push('\tJSValueRef result = nullptr;');
				clscode.push('\tif (type == kJSTypeString)');
				clscode.push('\t{');
				clscode.push('\t\tresult = ToString(ctx,nullptr,object,0,nullptr,exception);');
				clscode.push('\t}');
				clscode.push('\tauto po = ToNative(object);');
				clscode.push('\tif (type == kJSTypeNumber)');
				clscode.push('\t{');
				clscode.push('\t\tresult = JSValueMakeNumber(ctx,po->toNumber(ctx,exception));');
				clscode.push('\t}');
				clscode.push('\tif (type == kJSTypeBoolean)');
				clscode.push('\t{');
				clscode.push('\t\tresult = JSValueMakeBoolean(ctx,po->toBoolean(ctx,exception));');
				clscode.push('\t}');
				clscode.push('\t// should check exception and clear it out here,');
				clscode.push('\t// otherwise implicit conversion with \"+\" operator fails');
				clscode.push('\tif (!JSValueIsNull(ctx, *exception))');
				clscode.push('\t{');
				clscode.push('\t\t*exception = nullptr;');
				clscode.push('\t\treturn nullptr;');
				clscode.push('\t}');
				clscode.push('\treturn result;');
				clscode.push('}');
				clscode.push('');

				clscode.push(util.multilineComment('called to convert an '+cast+' to a JSValueRef'));
				clscode.push('EXPORTAPI JSValueRef '+mangledClassname+'_ToJSValue(JSContextRef ctx, '+cast+' instance, JSValueRef *exception)');
				clscode.push('{');
				typeobj.toNullCheck('instance','\t',clscode);
				clscode.push('\tauto po = new Hyperloop::NativeObject'+typeobj.getNewNativeObjectCast('instance')+';');
				clscode.push('\treturn JSObjectMake(ctx, RegisterClass(), po);');
				clscode.push('}');
				clscode.push('');

				if (typeobj.hasConstructor() && state.constructors && state.constructors[classname]) {
					Object.keys(state.constructors[classname]).forEach(function(key) {
						var m = state.constructors[classname][key];
						clscode.push(util.multilineComment('called when this class is called as function'));
						clscode.push('EXPORTAPI JSValueRef '+m.symbolname+'(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argumentCount, const JSValueRef arguments[], JSValueRef* exception)');
						clscode.push('{');
						clscode.push(library.generateNewInstance(state,metabase,'\t',classname,cast,'instance',m));
						clscode.push('\treturn instance ? '+mangledClassname+'_ToJSValue(ctx,instance,exception) : JSValueMakeUndefined(ctx);');
						clscode.push('}');
						clscode.push('');
					});
				}

				clscode.push('');
				//TODO: make ToString read/write
				clscode.push('static JSStaticFunction StaticFunctions[] = {');
				clscode.push('\t{ "toString", ToString, kJSPropertyAttributeReadOnly | kJSPropertyAttributeDontEnum | kJSPropertyAttributeDontDelete },');
				clscode.push('\t{ 0, 0, 0 }');
				clscode.push('};');
				clscode.push('');

				clscode.push(util.multilineComment('called to register this class into the JS engine'));
				clscode.push('static JSClassRef RegisterClass()');
				clscode.push('{');
				clscode.push('\tstatic JSClassRef jsClass;');
				clscode.push('\tif (!jsClass)');
				clscode.push('\t{');
				clscode.push('\t\tJSClassDefinition def = kJSClassDefinitionEmpty;');
				clscode.push('\t\tdef.initialize = Initializer;');
				clscode.push('\t\tdef.finalize = Finalizer;');
				clscode.push('\t\tdef.hasInstance = HasInstance;');
				clscode.push('\t\tdef.className = "'+classname+'";');
				clscode.push('\t\tdef.staticFunctions = StaticFunctions;');
				clscode.push('\t\tdef.convertToType = ConvertTo;');
				clscode.push('\t\tjsClass = JSClassCreate(&def);');
				clscode.push('\t}');
				clscode.push('\treturn jsClass;');
				clscode.push('}');
				clscode.push('');

				// conversion wrappers
				clscode.push(util.multilineComment('convert a JSValueRef to '+classname));
				clscode.push('EXPORTAPI '+cast+' JSValueTo_'+mangledClassname+'(JSContextRef ctx, JSValueRef value, JSValueRef *exception)');
				clscode.push('{');
				clscode.push('\tif (JSValueIsNull(ctx,value) || JSValueIsUndefined(ctx,value))');
				clscode.push('\t{');
				clscode.push('\t\t// this is a valid conversion. just return null since that was likely the intent');
				clscode.push('\t\treturn '+typeobj.toValueAtConversionFail()+';');
				clscode.push('\t}');
				clscode.push('\tauto object = JSValueToObject(ctx,value,exception);');
				clscode.push('\tif (object==nullptr)');
				clscode.push('\t{');
				clscode.push('\t\t*exception = HyperloopMakeException(ctx,"couldn\'t convert object to '+classname+'");');
				clscode.push('\t\treturn '+typeobj.toValueAtConversionFail()+';');
				clscode.push('\t}');
				clscode.push('\treturn ToNativeObject(object);');
				clscode.push('}');
				clscode.push('');
			}

			Object.keys(symbol.static_methods).forEach(function(methodname) {
				var entry = symbol.static_methods[methodname];
				log.info("Generating static method:",entry.name.yellow.bold);
				compileMethod(options,metabase,state,library,name,entry.name,entry.method,clscode);
			});

			Object.keys(symbol.instance_methods).forEach(function(methodname) {
				var entry = symbol.instance_methods[methodname];
				// TODO: review this, we need to skip generation of built-in methods. 
				// right now, toString is the only one
				if (!jsgen.isBuiltinFunction(entry.name)) {
					log.info("Generating instance method:",entry.name.yellow.bold);
					compileMethod(options,metabase,state,library,name,entry.name,entry.method,clscode);
				}
			});
			
			Object.keys(symbol.getters).forEach(function(propname) {
				var entry = symbol.getters[propname];
				log.info("Generating getter:",entry.name.yellow.bold);
				compileProperty(options,metabase,state,library,name,entry.name,entry.property,clscode,true);
			});
			
			Object.keys(symbol.setters).forEach(function(propname) {
				var entry = symbol.setters[propname];
				log.info("Generating setter:",entry.name.yellow.bold);
				compileProperty(options,metabase,state,library,name,entry.name,entry.property,clscode,false);
			});
			
			Object.keys(symbol.constructors).forEach(function(ctorname) {
				var entry = symbol.constructors[ctorname];
				//NOTE: constructors are always generated in the implementation right now
				//log.error('not yet generating constructor',entry);
			});

			var code = [];
			// generate header details
			code.push(HEADER);
			code.push(util.multilineComment('Hyperloop class library for '+name));
			code.push('');
			code.push('#include <hyperloop.h>');

			library.prepareIncludes && library.prepareIncludes(options,metabase,state,code);

			library.prepareHeader(options,metabase,state,classname,code);

			code.push('');

			clscode.unshift(code.join('\n'));
		
			library.prepareFooter(options,metabase,state,classname,clscode);

			// determine the filename
			var outfn = path.join(options.srcdir, library.getClassFilename(options, metabase, state, mangledClassname));

			// write source file if required
			writeSourceFile(options,library,outfn,clscode);
		});

		generateTypes(options, metabase, library);
	}

}
