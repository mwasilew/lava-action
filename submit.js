const core = require('@actions/core');
const github = require('@actions/github');
const YAML = require('yaml')

const job_definition_path = core.getInput('job_definition')
const lava_token = core.getInput('lava_token')
const lava_url = core.getInput('lava_url')
const wait_for_job = core.getInput('wait_for_job')
// colors

const ColorReset = "\x1b[0m";

const BackgroundColor = {
    info: "\x1b[46m",
    debug: "\x1b[43m",
    results: "\x1b[44m",
    target: "\x1b[42m",
    error: "\x1b[41m",
    exception: "\x1b[45m",
    input: "\x1b[40m",
    feedback: "\x1b[102m",
    warning: "\x1b[103m",
}
// read from file
const fs = require ('fs');
var lava_job_ids;
var file;
try {
    file = fs.readFileSync(job_definition_path, 'utf-8');
} catch (err) {
    console.log("Error reading job definition file")
    core.setFailed(err.message);
}
// submit to lava
const request = require('request');
const rp = require('request-promise');

const tokenString = 'Token ' + lava_token

var options = {
    url: 'https://' + lava_url + '/api/v0.2/jobs/',
    method: 'POST',
    headers: {
       'Authorization': tokenString
    },
    json: {
       'definition' : file
    }
};

rp(options).then(
    function( body ) { 
        lava_job_ids = body.job_ids;
        job_id = lava_job_ids[0];
        log_start = 0;
        console.log("Job ID: ", job_id);
        var job_status_options = {
            url: 'https://' + lava_url + '/api/v0.2/jobs/' + job_id + '/',
            method: 'GET',
            headers: {
                'Authorization': tokenString
            },
            json: true,
            simple: false,
            resolveWithFullResponse: false
        };
        var job_log_options = {
            url: 'https://' + lava_url + '/api/v0.2/jobs/' + job_id + '/logs/?start=' + log_start,
            method: 'GET',
            headers: {
                'Authorization': tokenString
            },
            json: true,
            simple: false,
            resolveWithFullResponse: false
        };

        var job_status = rp(job_status_options).promise();
        var job_log = rp(job_log_options).promise();
        var promiseStack = []
        promiseStack.push(job_status)
        promiseStack.push(job_log)
        function recurseAll(parray) {
            return Promise.all([rp(job_status_options).promise(), rp(job_log_options).promise()]).then( values => {
                job_status = values[0];
                job_log = values[1];
                if ( job_status.state == "Submitted" || job_status.state == "Scheduled" ) {
                    console.log("Job state: ", job_status.state);
                } else {
                    if ( job_log.length ) {
                        yaml_log = YAML.parse(job_log)
                        for ( line of yaml_log ) {
                            var textFormat = BackgroundColor[line.lvl];
                            if ( line.lvl == "results" ) {
                                console.log(`${textFormat}case: ${line.msg.case} | definition: ${line.msg.definition} | result: ${line.msg.result} ${ColorReset}`);
                            } else {
                                console.log(`${textFormat}${line.msg}${ColorReset}`);
                            }
                            log_start += 1;
                        }
                        job_log_options = {
                          url: 'https://' + lava_url + '/api/v0.2/jobs/' + job_id + '/logs/?start=' + log_start,
                          method: 'GET',
                          headers: {
                            'Authorization': tokenString
                            },
                          json: true,
                          simple: false,
                          resolveWithFullResponse: false
                        };
                    }
                }
                if ( job_status.state == "Finished" ) {
                    return values
                }
                return setTimeout(() => recurseAll([rp(job_status_options).promise(), rp(job_log_options).promise()]), 5000);
            }).catch ( error => { console.log ("Request Error") });
        };
        recurseAll(promiseStack);
    });

console.log(lava_job_ids);

