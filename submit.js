const fs = require("fs");

const core = require('@actions/core');
const github = require('@actions/github');
const undici = require('undici');
const YAML = require('yaml')

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

const testResults = new Map();

async function printResults(fail_action) {
    console.log("Printing results")
    var hasFailures = false;
    var failedTest;
    for ( let [key, value] of testResults ) {
        console.log(key + ": " + value);
        if ( value == "fail" ) {
            hasFailures = true;
            failedTest = key;
        }
    }
    if ( hasFailures && fail_action == "true" ) {
        console.log("Action failed because of test failure");
        core.setFailed(failedTest);
    }
}

async function fetchAndParse(jobId, logStart, host, fail_action_on_failure) {
    const jobStatusPath = "/api/v0.2/jobs/" + jobId + "/";
    const jobLogPath = "/api/v0.2/jobs/" + jobId + "/logs/?start=" + logStart;

    const [jobStatusResponse, jobLogResponse] = await Promise.all([
        undici.request(new URL(jobStatusPath, host)),
        undici.request(new URL(jobLogPath, host))
    ]);

    const { body: jobStatusBody, statucCode: jobStatusCode } = jobStatusResponse;
    const { body: jobLogBody, statusCode: jobLogStatusCode } = jobLogResponse;

    const jobStatus = await jobStatusBody.json();
    const jobLog = await jobLogBody.text();

    if (jobStatusCode >= 400){
        throw new Error('Error retrieving lava job');
    }

    const { state } = jobStatus;
    const { health } = jobStatus;

    if (state === "Finished") {
        printResults(fail_action_on_failure);
        if (health === "Incomplete" || health === "Canceled") {
            console.log("Action failed because of job failure");
            core.setFailed(health);
        }
        return testResults;
    }

    if (state === "Submitted" || state === "Scheduled") {
        console.log("Job state: %s", state);
    } else {
        if (jobLogStatusCode == 200) {
            yaml_log = YAML.parse(jobLog);

            for (const line of yaml_log) {
                const { lvl, msg } = line;
                const { case: msgCase, definition, result } = msg;

                const textFormat = BackgroundColor[lvl];
                if (lvl === "results") {
                    console.log(`${textFormat}case: %s | definition: %s | result: %s ${ColorReset}`, msgCase, definition, result );
                    const testFullName = definition + '/' + msgCase
                    testResults.set(testFullName, result);
                } else {
                    console.log(`${textFormat}${msg}${ColorReset}`);
                }
                logStart += 1;
            }
        }
    }

    return setTimeout(() => fetchAndParse(jobId, logStart, host, fail_action_on_failure), 5000);
}


async function main() {
    let file;
    let job_definition_path;
    let lava_token;
    let lava_url;
    let wait_for_job;
    let fail_action_on_failure;

    try {
        job_definition_path = core.getInput("job_definition");
        lava_token = core.getInput("lava_token");
        lava_url = core.getInput("lava_url");
        wait_for_job = core.getInput("wait_for_job");
        fail_action_on_failure = core.getInput("fail_action_on_failure");
    } catch (ex) {
        console.log("Error reading input variables");
        core.setFailed(err.message);

        return;
    }

    const tokenString = "Token " + lava_token;
    const host = "https://" + lava_url;

    try {
        file = fs.readFileSync(job_definition_path, "utf-8");
    } catch (err) {
        console.log("Error reading job definition file");
        core.setFailed(err.message);

        return;
    }

    try {
        const url = new URL("/api/v0.2/jobs/", host);
        const options = {
          method: "POST",
          headers: {
            'Authorization': tokenString,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            definition: file,
          }),
        };

        const { statusCode, body } = await undici.request(
            url,
            options
        );

        if (statusCode === 201) {
            lavaJob = await body.json();
        } else {
            console.log("Error %s retrieving lava job", statusCode);
            core.setFailed(await body.json());

            return;
        }
    } catch (ex) {
        console.log("Error retrieving lava job");
        core.setFailed(ex.message);

        return;
    }

    const jobId = lavaJob.job_ids[0];

    console.log("Job ID: ", jobId);

    if ( wait_for_job == "true" ) {
        return await fetchAndParse(jobId, 0, host, fail_action_on_failure);
    }
    return true
}

main().then((data) => {
}).catch((ex) => {
    console.log('Error running action');
    core.setFailed(ex.message);
})
