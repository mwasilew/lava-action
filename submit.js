const core = require('@actions/core');
const github = require('@actions/github');

const job_definition_path = core.getInput('job-definition')
const lava_token = core.getInput('lava-token')
const lava_url = core.getInput('lava-url')

// read from file
const fs = require ('fs');
const file = fs.readFileSync(job_definition_path, 'utf-8');

// submit to lava
const https = require('https');

var postData = JSON.stringify({
    'definition' : file
});

const tokenString = 'Token ${lava_token}'

var options = {
  hostname: lava_url,
  port: 443,
  path: '/api/v0.2/jobs/',
  method: 'POST',
  headers: {
       'Content-Type': 'application/json',
       'Content-Length': postData.length,
       'Authorization': tokenString
     }
};

var req = https.request(options, (res) => {
  console.log('statusCode:', res.statusCode);
  console.log('headers:', res.headers);

  res.on('data', (d) => {
    process.stdout.write(d);
  });
});

req.on('error', (e) => {
  console.error(e);
});

req.write(postData);
req.end();

