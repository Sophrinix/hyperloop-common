var sprintf = require('util').format,
    colors = require('colors'),
    log = require('./log'),
    timer;

var spinner = 'win32' == process.platform
    ? ['|','/','-','\\']
    : ['◜','◠','◝','◞','◡','◟'];

function play(arr) {
  var len = arr.length,
    i = 0;

  timer = setInterval(function(){
    var str = '\u001b[0G' + arr[i++ % len],
        value = log.useColor ? str : str.stripColors;
    value && process.stdout.write(value);
  }, 100);
}

exports.start = function(msg, prefix) {
  if (log.level === 'quiet') { return; }
  if (!process.stdout.isTTY) { return; } // if not connected to TTY, don't run

  msg = msg || '';
  var frames = spinner.map(function(c) {
    var str = sprintf('  \u001b[96m%s \u001b[90m'+msg+'\u001b[0m', c);
    return log.useColor ? str : str.stripColors;
  });

  prefix && log.info(prefix);
  play(frames);
};

exports.stop = function() {
  if (timer){
    clearInterval(timer);
    timer = null;
  }
  else {
    return;
  }
  log.log(' ');
  log.log(' ');
};
