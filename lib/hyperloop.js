/**
 * Hyperloop
 * Copyright (c) 2014 by Appcelerator, Inc. All Rights Reserved.
 * See LICENSE for more information on licensing.
 */
var _ = require('underscore'),
	path = require('path'),
	fs = require('fs'),
	log = require('./log'),
	pkg = JSON.parse(fs.readFileSync(__dirname + '/../package.json', 'utf8')),
	config = require('./config'),
	Hook = require('./hook'),
	Command = require('./command'),
	commands;

exports.run = run;
exports.getCommands = getCommands;
exports.getCommand = getCommand;

/**
 * Default options
 */
var defaultOptions = {
	name: 'App',
	src: process.cwd(),
	dest: 'build',
	debug: false,
	'log-level': 'info',
	excludes: /^\.hyperloop$/,
	obfuscate: true
};
switch (process.platform) {
	case 'win32':
		defaultOptions.platform = 'windows';
		break;
	case 'darwin':
		defaultOptions.platform = 'ios';
		break;
	default:
		defaultOptions.platform = 'android';
		break;
}

function makeSafeName (name) {
	return name.replace(/[\s\+\-\$\@\!\?\*\%\#\:\;\/]/g,'_');
}

/**
 * execute a specific command
 */
function run(command, options, platform, args, done) {
	var found = getCommand(platform,command),
		workDir = options.src || process.cwd();

	if (!found) {
		log.fatal("Command not found: "+command);
	}
	delete options.colors; // we don't need our color config

	options = _.defaults(options,defaultOptions);

	// make sure we set reasonable defaults.
	platform.defaultOptions && (options=_.defaults(options,platform.defaultOptions));

	// load our configuration
	options = config.load(workDir,options);

	// change log level if debug flag passed
	if (options.debug) {
		options['log-level'] = 'debug';
	}

	// make sure we set our log-level in case it changed in config loading
	log.level = options['log-level'];

	// make a safe name
	options.name && (options.safeName = makeSafeName(options.name));

	var cmd = getCommand(platform,command);

	// validate the options
	cmd.getOptions().forEach(function(option){
		if (!(option.name in options) && option.required) {
			log.fatal("Missing required option "+("--"+option.name).magenta.bold+" "+command+" which should "+option.description);
		}
	});

	// common constants
	options.platform_dir = platform.directory;

	var state = {options:options, args:args};

	// Hooks
	state.hook = new Hook();
	
	//
	// search order for hooks:
	//
	// 1. [project source directory]/hooks
	// 2. [project source parent directory]/hooks   (such as <titanium dir>/Resources/../hooks if Resources was the source directory)
	// 3. [platform directory]/hooks
	// 4. [current working directory]/hooks
	//
	[options.src, path.join(options.src,'..'), options.platform_dir, process.cwd()].forEach(function(d){
		var dir = path.join(d, 'hooks');
		log.info('scanning for hooks in',dir);
		state.hook.scanHooks(dir);
	});

	state.hook.emit(command+'.pre.execute', state);

	cmd.executionStartedAt = Date.now();
	cmd.execute(state, function(err, results) {
		if (err) {
			log.error(createErrorOutput(err));
			log.error('Hint: If you think you have found a bug, run again with '.grey + '--report'.bold + ' to report it.'.grey);
			log.error('Running with '.grey + '--debug'.bold + ' can also give you more information on what is going wrong.'.grey);
		}
		finishedCommand(cmd);
		if (done) {
			done(err, results);
		}
	});
}

function finishedCommand(command) {
	log.trace(command.name.yellow + ' finished in ' + String((Date.now() - command.executionStartedAt) / 1000).yellow + ' seconds.\n\n');
}

function createErrorOutput(e) {
	var errs = [];

	if (typeof e == 'object') {
		var line = e.line || e.lineNumber;
		if (line)  { errs.push('line ' + line); }
		if (e.col) { errs.push('column ' + e.col); }
		if (e.pos) { errs.push('position ' + e.pos); }
		if (e.stack) {errs.unshift(e.stack);}
	} else {
		errs.push(e);
	}

	return errs.join('\n');
}

function getCommands(platform) {
	if (!platform) throw new Error("missing platform argument");
	if (commands) { return commands; }
	try {
		// platform takes precendence over common
		var commandDirs = [path.join(platform.directory,'commands'), path.join(__dirname,'commands')],
			found = {},
			x = commandDirs.forEach(function(dir) {
				fs.readdirSync(dir).forEach(function(d){
					var name = path.basename(d),
						dn = path.join(dir, d, 'index.js');
					if (!(name in found) && fs.existsSync(dn)) {
						log.info(dn)
						found[name] = require(dn);
					}
				});
			});
		return (commands = found);
	} catch (e) {
		log.debug(e.stack)
		log.fatal('Error getting command list', e);
	}
}

function getCommand(platform,name) {
	if (!commands && arguments.length<2) throw new Error("call getCommands first or pass in platform as first argument");
	if (arguments.length===2 && !commands) {
		getCommands(platform);
	}
	else if (arguments.length===1) {
		name = platform;
		platform = null;
	}
	return commands[name];
}