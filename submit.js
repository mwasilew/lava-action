const fs = require("fs");

const core = require('@actions/core');
const github = require('@actions/github');
const {DefaultArtifactClient} = require('@actions/artifact')
const undici = require('undici');
const YAML = require('yaml')
const ColorReset = "\033[0m";

async function writeFileWithRetry(fileName, content) {
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            await fs.promises.writeFile(fileName, content);
            return;
        } catch (err) {
            if (attempt === 2) throw err;
            console.error("Write failed, retrying: " + err.message);
        }
    }
}

const BackgroundColor = {
    info: "\033[38;5;0;48;5;195m",
    debug: "\033[38;5;0;48;5;224m",
    results: "\033[38;5;195;48;5;63m",
    target: "\033[38;5;0;48;5;112m",
    error: "\033[38;5;0;48;5;196m",
    exception: "\033[38;5;0;48;5;210m",
    input: "\033[38;5;231;48;5;237m",
    feedback: "\033[38;5;0;48;5;118m",
    warning: "\033[38;5;0;48;5;220m",
}

const testResults = new Map();

async function createRequest(method, url, token) {
    const tokenString = "Token " + token;
    const options = {
      method: method,
      headers: {
        'Authorization': tokenString,
        "content-type": "application/json"
      },
    };
    return undici.request(url, options)
}

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
    if ( hasFailures && fail_action ) {
        console.log("Action failed because of test failure");
        core.setFailed(failedTest);
    }
}

async function saveArtifacts(jobId, host, lava_token, save_result_as_artifact, result_file_name) {
    console.log("Saving artifacts: " + save_result_as_artifact);
    if (result_file_name) {
        console.log("Saving to file: " + result_file_name + ".xml")
    }

    if (save_result_as_artifact){
        const artifact = new DefaultArtifactClient()
        // Save results as artifact
        const jobResultsPath = "/api/v0.2/jobs/" + jobId + "/junit/";
        const [jobResults] = await Promise.all([
            createRequest("GET", new URL(jobResultsPath, host), lava_token),
        ]);

        const { body: jobResultsBody, statusCode: jobResultsStatusCode } = jobResults;

        if (jobResultsStatusCode >= 400) {
            console.log("Error retrieving job results");
        }
        let resultsName = "test-results-" + jobId
        if (result_file_name) {
            resultsName = result_file_name
        }
        const fileName = "./" + resultsName + ".xml"
        console.log("Writing to: " + fileName);
        const resultsBody = await jobResultsBody.text();
        try {
            await writeFileWithRetry(fileName, resultsBody);
        } catch (err) {
            console.error("Error writing results file: " + err.message);
        }
        await fs.stat(fileName, (error, stats) => {
          if (error) {
            console.log(error);
          }
          else {
            console.log("Stats object for: " + fileName);
            console.log(stats);
          }
        });

        try {
            // delete previous_result before saving new file
            let previous_result = await artifact.deleteArtifact(resultsName)
        }
        catch (error) {
            console.log(error)
        }
        const {id, size} = await artifact.uploadArtifact(
            resultsName,
            [fileName],
            "./"
        )

        console.log(`Created artifact with id: ${id}, bytes: ${size}, name: ${fileName}`)
    }
}

async function fetchAndParse(settings) {
    const jobStatusPath = "/api/v0.2/jobs/" + settings.jobId + "/";
    const jobLogPath = "/api/v0.2/jobs/" + settings.jobId + "/logs/?start=" + settings.logStart;

    const [jobStatusResponse, jobLogResponse] = await Promise.all([
        createRequest("GET", new URL(jobStatusPath, settings.host), settings.lava_token),
        createRequest("GET", new URL(jobLogPath, settings.host), settings.lava_token),
    ]);

    const { body: jobStatusBody, statusCode: jobStatusCode } = jobStatusResponse;
    const { body: jobLogBody, statusCode: jobLogStatusCode } = jobLogResponse;

    if (jobStatusCode >= 400) {
        console.log("Error retrieving job status");
        return setTimeout(() => fetchAndParse(settings), 5000);
    }
    if (jobLogStatusCode >= 400) {
        console.log("Error retrieving job logs");
    }

    const jobStatus = await jobStatusBody.json();
    const jobLog = await jobLogBody.text();

    const { state } = jobStatus;
    const { health } = jobStatus;

    if (state === "Submitted" || state === "Scheduled") {
        console.log("Job state: %s", state);
    } else {
        if (jobLogStatusCode == 200) {
            try {
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
                    settings.logStart += 1;
                }
            }
            catch (error) {
                console.log(error.message)
            }
        }
    }

    if (state === "Finished") {
        saveArtifacts(settings.jobId, settings.host, settings.lava_token, settings.save_result_as_artifact, settings.result_file_name);
        printResults(settings.fail_action_on_failure);
        if (health === "Incomplete" || health === "Canceled") {
            if (settings.fail_action_on_incomplete) {
                console.log("Action failed because of job failure");
                core.setFailed(health);
            }
        }
        return testResults;
    }

    return setTimeout(() => fetchAndParse(settings), 5000);
}


async function main() {
    let file;
    let job_definition_path;
    let lava_token;
    let lava_url;
    let wait_for_job;
    let fail_action_on_failure;
    let fail_action_on_incomplete;
    let save_result_as_artifact;
    let save_job_details;
    let result_file_name;
    let test_job_file_name_prefix;

    try {
        job_definition_path = core.getInput("job_definition", {required: true});
        lava_token = core.getInput("lava_token", {required: true});
        lava_url = core.getInput("lava_url", {required: true});
        wait_for_job = core.getBooleanInput("wait_for_job", {required: true});
        fail_action_on_failure = core.getBooleanInput("fail_action_on_failure", {required: true});
        fail_action_on_incomplete = core.getBooleanInput("fail_action_on_incomplete", {required: true});
        save_result_as_artifact  = core.getBooleanInput("save_result_as_artifact", {required: true});
        save_job_details  = core.getBooleanInput("save_job_details", {required: true});
        result_file_name = core.getInput("result_file_name", {required: false});
        test_job_file_name_prefix = core.getInput("test_job_file_name_prefix", {required: false});
        console.log("Wait for job: " + wait_for_job);
        console.log("Fail on failure: " + fail_action_on_failure);
        console.log("Save artifact: " + save_result_as_artifact);
        console.log("Save job details: " + save_job_details);
        if (result_file_name) {
            console.log("Result file name: " + result_file_name);
        }
        if (test_job_file_name_prefix) {
            console.log("Job details filename prefix: " + test_job_file_name_prefix);
        }
    } catch (ex) {
        console.log("Error reading input variables");
        core.setFailed(ex.message);

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
    console.log("Job URL: ", host + "/scheduler/job/" + jobId);
    if ( save_job_details ) {
        const jobDetailsPath = "/api/v0.2/jobs/" + jobId + "/";

        const [jobDetails] = await Promise.all([
            createRequest("GET", new URL(jobDetailsPath, host), lava_token)
        ]);

        const { body: jobDetailsBody, statusCode: jobDetailsStatusCode } = jobDetails;

        if (jobDetailsStatusCode >= 400) {
            console.log("Error retrieving job details");
        }

        let detailsBody = await jobDetailsBody.json();
        detailsBody.url = host + "/scheduler/job/" + jobId;
        const fileName = "./" + test_job_file_name_prefix + "test-job-" + jobId + ".json"
        console.log("Write job details to file");
        try {
            await writeFileWithRetry(fileName, JSON.stringify(detailsBody));
        } catch (err) {
            console.error("Error writing job details file: " + err.message);
        }
        await fs.stat(fileName, (error, stats) => {
          if (error) {
            console.log(error);
          }
          else {
            console.log("Stats object for: " + fileName);
            console.log(stats);
          }
        });

        const artifact = new DefaultArtifactClient()
        const {id, size} = await artifact.uploadArtifact(
            test_job_file_name_prefix + "test-job-" + jobId,
            [fileName],
            "./"
        )
        console.log(`Created artifact with id: ${id}, bytes: ${size}, name: ${fileName}`)
    }
    let settings = {
        jobId: jobId,
        logStart: 0,
        host: host,
        lava_token: lava_token,
        fail_action_on_failure: fail_action_on_failure,
        fail_action_on_incomplete: fail_action_on_incomplete,
        save_result_as_artifact: save_result_as_artifact,
        result_file_name: result_file_name
    }

    if ( wait_for_job ) {
        return await fetchAndParse(settings);
    }
    return true
}

main().then((data) => {
}).catch((ex) => {
    console.log('Error running action');
    core.setFailed(ex.message);
})
