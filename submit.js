const core = require('@actions/core');
const github = require('@actions/github');

const job_definition_path = core.getInput('job_definition')
const lava_token = core.getInput('lava_token')
const lava_url = core.getInput('lava_url')
const wait_for_job = core.getInput('wait_for_job')

// colors

const ColorReset = "\x1b[0m";

enum BackgroudColor {
    info = "\x1b[46m",
    debug = "\x1b[43m",
    results = "\x1b[44m",
    target = "\x1b[42m",
    error = "\x1b[41m",
    exception = "\x1b[45m",
}


// read from file
const fs = require ('fs');
const file;
try {
  file = fs.readFileSync(job_definition_path, 'utf-8');
} catch (err) {
  console.log("Error reading job definition file")
  core.setFailed(err.message);
}
// submit to lava
const request = require('request');

var lava_job_ids;

function callback(error, response, body) {
  if (error) {
      console.log(error)
      core.setFailed(error)
  }
  if (response.statusCode != 201) {
      core.setFailed(response.statusCode)
  }
  var res = JSON.parse(body);
  lava_jobs_ids = res.job_ids
}

const tokenString = 'Token ' + lava_token

var options = {
  hostname: 'https://' + lava_url + '/api/v0.2/jobs/',
  method: 'POST',
  headers: {
       'Authorization': tokenString
     },
  json: {
       'definition' : file
     }
};

request(options, callback)

if ( wait_for_job ) {
  for ( const job_id in lava_job_ids ) {
    // check job status
    var job_status;
    var job_status_options = {
      hostname: 'https://' + lava_url + '/api/v0.2/jobs/' + job_id + '/',
      method: 'GET',
      headers: {
           'Authorization': tokenString
         }
    };

    function job_status_callback(error, response, body) {
      if (!error && response.statusCode == 200) {
        const job = JSON.parse(body);
        job_status = job.State
      }
    }
    request(job_status_options, job_status_callback)

    var log_start = 0;
    while ( job_status == "Running" ) {
      // stream job logs
      var job_log_options = {
        hostname: 'https://' + lava_url + '/api/v0.2/jobs/' + job_id + '/logs/?start=' + log_start,
        method: 'GET',
        headers: {
          'Authorization': tokenString
          }
      };

      function job_log_callback(error, response, body) {
        if (!error && response.statusCode == 200) {
          const job_log = JSON.parse(body);
          job_log.forEach(function(line) {
            var textFormat = BackgroundColor[line.lvl as keyof typeof BackgroundColor]
            console.log(`${textFormat}${line.msg}${ColorReset}`);
            log_start += 1;
          });
        }
      }
      request(job_log_options, job_log_callback)
      request(job_status_options, job_status_callback)
    }
  }
}
