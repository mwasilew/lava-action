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

// Accepted values in the "fake_results" spec.
const FAKE_SPEC_KEYS = [
    "job_id", "job_index",
    "state", "health", "error", "submitter", "description", "suites",
];
const FAKE_STATE_VALUES = ["Submitted", "Scheduled", "Running", "Canceling", "Finished"];
const FAKE_HEALTH_VALUES = ["Complete", "Incomplete", "Canceled", "Unknown"];
const FAKE_RESULT_VALUES = ["pass", "fail", "skip", "unknown"];

// Field widths of the derived fake job ID, see fakeJobId().
const MAX_FAKE_ATTEMPT = 99;
const MAX_FAKE_JOB_INDEX = 999;

// Used when "fake_results" is not set, so that existing users of
// "fake_lava_submission" keep the results they had before.
const DEFAULT_FAKE_SUITES = [
    {
        name: "0_fake-suite",
        cases: [
            { name: "test-pass-1", result: "pass", message: "" },
            { name: "test-pass-2", result: "pass", message: "" },
        ],
    },
];

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

async function saveResultsFile(jobId, resultsBody, save_result_as_artifact, result_file_name) {
    let resultsName = "test-results-" + jobId
    if (result_file_name) {
        resultsName = result_file_name
    }
    const fileName = "./" + resultsName + ".xml"
    console.log("Writing to: " + fileName);
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

    if (save_result_as_artifact){
        const artifact = new DefaultArtifactClient()
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

async function saveArtifacts(jobId, host, lava_token, save_result_as_artifact, result_file_name) {
    console.log("Saving artifacts: " + save_result_as_artifact);
    if (result_file_name) {
        console.log("Saving to file: " + result_file_name + ".xml")
    }

    if (save_result_as_artifact){
        // Save results as artifact
        const jobResultsPath = "/api/v0.2/jobs/" + jobId + "/junit/";
        const [jobResults] = await Promise.all([
            createRequest("GET", new URL(jobResultsPath, host), lava_token),
        ]);

        const { body: jobResultsBody, statusCode: jobResultsStatusCode } = jobResults;

        if (jobResultsStatusCode >= 400) {
            console.log("Error retrieving job results");
        }
        const resultsBody = await jobResultsBody.text();
        await saveResultsFile(jobId, resultsBody, save_result_as_artifact, result_file_name);
    }
}

async function saveJobDetails(detailsBody, jobId, host, test_job_file_name_prefix) {
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

function escapeXml(value) {
    return String(value === undefined || value === null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function envInteger(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === "") {
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(name + ' is not a positive integer (got "' + raw + '")');
    }
    return value;
}

// Build the fake job ID by packing three deterministic, bounded counters into
// decimal fields:
//
//     <run number><attempt: 2 digits><job_index: 3 digits>
//
// Packing rather than hashing keeps the mapping injective, so IDs cannot
// collide at all instead of being merely unlikely to. GITHUB_RUN_NUMBER is
// unique per workflow run and stable across re-runs, GITHUB_RUN_ATTEMPT
// increments on every re-run, and job_index separates the matrix legs and the
// repeated uses of this action inside one workflow job - neither of which is
// visible in the environment.
//
// GITHUB_RUN_ID is deliberately not used: it is around 11 digits, and packing
// it would push the result past Number.MAX_SAFE_INTEGER. GITHUB_RUN_NUMBER
// identifies the run just as uniquely within the workflow.
//
// Outside a runner both variables are unset, so local runs stay reproducible.
function fakeJobId(jobIndex) {
    const runNumber = envInteger("GITHUB_RUN_NUMBER", 0);
    const attempt = envInteger("GITHUB_RUN_ATTEMPT", 1);

    if (attempt > MAX_FAKE_ATTEMPT) {
        throw new Error("GITHUB_RUN_ATTEMPT is above " + MAX_FAKE_ATTEMPT
            + ", cannot derive a unique job ID - pin one with job_id");
    }

    const jobId = (runNumber * (MAX_FAKE_ATTEMPT + 1) + attempt) * (MAX_FAKE_JOB_INDEX + 1) + jobIndex;
    if (!Number.isSafeInteger(jobId)) {
        throw new Error("GITHUB_RUN_NUMBER is too large to derive a unique job ID - pin one with job_id");
    }
    return jobId;
}

// Turn the "fake_results" input into a normalised spec. Accepts YAML or JSON
// (JSON is valid YAML). Throws on anything malformed so the action can fail with
// a message naming the offending field instead of producing bogus results.
function parseFakeResults(specText) {
    const source = specText ? specText.trim() : "";
    const spec = {
        jobId: 0,
        state: "Finished",
        health: "Complete",
        error: null,
        submitter: "fake",
        description: "Fake LAVA job",
        suites: [],
    };

    if (!source) {
        spec.jobId = fakeJobId(0);
        spec.suites = DEFAULT_FAKE_SUITES;
        return spec;
    }

    let parsed;
    try {
        parsed = YAML.parse(source);
    } catch (err) {
        throw new Error("invalid YAML/JSON - " + err.message.split("\n")[0]);
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("must be a YAML/JSON mapping");
    }

    for (const key of Object.keys(parsed)) {
        if (!FAKE_SPEC_KEYS.includes(key)) {
            throw new Error('unknown key "' + key + '" (allowed: ' + FAKE_SPEC_KEYS.join(", ") + ")");
        }
    }

    let jobIndex = 0;
    if (parsed.job_index !== undefined && parsed.job_index !== null) {
        jobIndex = Number(parsed.job_index);
        if (!Number.isInteger(jobIndex) || jobIndex < 0 || jobIndex > MAX_FAKE_JOB_INDEX) {
            throw new Error("job_index must be an integer between 0 and " + MAX_FAKE_JOB_INDEX);
        }
    }

    if (parsed.job_id === undefined || parsed.job_id === null) {
        spec.jobId = fakeJobId(jobIndex);
    } else {
        const jobId = Number(parsed.job_id);
        if (!Number.isInteger(jobId) || jobId <= 0) {
            throw new Error("job_id must be a positive integer");
        }
        spec.jobId = jobId;
    }

    if (parsed.state !== undefined && parsed.state !== null) {
        if (!FAKE_STATE_VALUES.includes(parsed.state)) {
            throw new Error("state must be one of " + FAKE_STATE_VALUES.join(", ") + ' (got "' + parsed.state + '")');
        }
        spec.state = parsed.state;
    }

    if (parsed.health !== undefined && parsed.health !== null) {
        if (!FAKE_HEALTH_VALUES.includes(parsed.health)) {
            throw new Error("health must be one of " + FAKE_HEALTH_VALUES.join(", ") + ' (got "' + parsed.health + '")');
        }
        spec.health = parsed.health;
    }

    if (parsed.submitter !== undefined && parsed.submitter !== null) {
        spec.submitter = String(parsed.submitter);
    }

    if (parsed.description !== undefined && parsed.description !== null) {
        spec.description = String(parsed.description);
    }

    if (parsed.error !== undefined && parsed.error !== null) {
        if (typeof parsed.error === "string") {
            spec.error = { code: 500, message: parsed.error };
        } else if (typeof parsed.error === "object" && !Array.isArray(parsed.error)) {
            const code = parsed.error.code === undefined ? 500 : Number(parsed.error.code);
            if (!Number.isInteger(code)) {
                throw new Error("error.code must be an integer");
            }
            const message = parsed.error.message === undefined
                ? "Internal Server Error"
                : String(parsed.error.message);
            spec.error = { code: code, message: message };
        } else {
            throw new Error("error must be a string or a mapping");
        }
    }

    if (parsed.suites === undefined || parsed.suites === null) {
        // Every key of the spec is optional and independent of the others, so a
        // spec that says nothing about the results gets the same default as no
        // spec at all. Without this, injecting a single unrelated key such as
        // job_index silently turns a job into one that reports no tests.
        spec.suites = DEFAULT_FAKE_SUITES;
    } else {
        if (!Array.isArray(parsed.suites)) {
            throw new Error("suites must be a list");
        }
        parsed.suites.forEach((suite, suiteIndex) => {
            const suiteWhere = "suites[" + suiteIndex + "]";
            if (suite === null || typeof suite !== "object" || Array.isArray(suite)) {
                throw new Error(suiteWhere + " must be a mapping");
            }
            if (!suite.name) {
                throw new Error(suiteWhere + ' requires "name"');
            }
            const suiteCases = suite.cases === undefined || suite.cases === null ? [] : suite.cases;
            if (!Array.isArray(suiteCases)) {
                throw new Error(suiteWhere + ".cases must be a list");
            }
            const cases = [];
            suiteCases.forEach((testCase, caseIndex) => {
                const where = suiteWhere + ".cases[" + caseIndex + "]";
                if (testCase === null || typeof testCase !== "object" || Array.isArray(testCase)) {
                    throw new Error(where + " must be a mapping");
                }
                if (!testCase.name) {
                    throw new Error(where + ' requires "name"');
                }
                const result = testCase.result === undefined || testCase.result === null
                    ? "pass"
                    : String(testCase.result);
                if (!FAKE_RESULT_VALUES.includes(result)) {
                    throw new Error(where + ".result must be one of " + FAKE_RESULT_VALUES.join(", ") + ' (got "' + result + '")');
                }
                cases.push({
                    name: String(testCase.name),
                    result: result,
                    message: testCase.message === undefined || testCase.message === null
                        ? ""
                        : String(testCase.message),
                });
            });
            spec.suites.push({ name: String(suite.name), cases: cases });
        });
    }

    return spec;
}

// Build a JUnit XML document in the same shape LAVA's /junit/ endpoint
// returns, so the produced file is compatible with real submissions.
// A spec with no suites produces a valid, empty document.
function buildFakeJunit(spec) {
    const countResult = (cases, result) => cases.filter(c => c.result === result).length;

    let totalTests = 0;
    let totalFailures = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    for (const suite of spec.suites) {
        totalTests += suite.cases.length;
        totalFailures += countResult(suite.cases, "fail");
        totalSkipped += countResult(suite.cases, "skip");
        totalErrors += countResult(suite.cases, "unknown");
    }

    let xml = `<?xml version="1.0" encoding="utf-8"?>\n`;
    xml += `<testsuites disabled="0" errors="${totalErrors}" failures="${totalFailures}" skipped="${totalSkipped}" tests="${totalTests}" time="0">\n`;
    for (const suite of spec.suites) {
        const name = escapeXml(suite.name);
        const failures = countResult(suite.cases, "fail");
        const skipped = countResult(suite.cases, "skip");
        const errors = countResult(suite.cases, "unknown");
        xml += `\t<testsuite disabled="0" errors="${errors}" failures="${failures}" name="${name}" skipped="${skipped}" tests="${suite.cases.length}" time="0">\n`;
        for (const c of suite.cases) {
            const caseName = escapeXml(c.name);
            if (c.result === "pass") {
                xml += `\t\t<testcase classname="${name}" name="${caseName}"/>\n`;
                continue;
            }
            xml += `\t\t<testcase classname="${name}" name="${caseName}">\n`;
            if (c.result === "fail") {
                xml += `\t\t\t<failure type="fail" message="${escapeXml(c.message || c.name + " failed")}"/>\n`;
            } else if (c.result === "skip") {
                xml += `\t\t\t<skipped message="${escapeXml(c.message || c.name + " skipped")}"/>\n`;
            } else {
                xml += `\t\t\t<error type="unknown" message="${escapeXml(c.message || c.name + " has no result")}"/>\n`;
            }
            xml += `\t\t</testcase>\n`;
        }
        xml += `\t</testsuite>\n`;
    }
    xml += `</testsuites>\n`;
    return xml;
}

// Produce results compatible with a real LAVA submission without contacting
// any LAVA instance. Useful for testing the workflow that consumes this action.
async function fakeSubmission(settings) {
    console.log("FAKE LAVA submission - no job will be sent to LAVA");
    const spec = settings.spec;
    const jobId = spec.jobId;

    console.log("Job ID: ", jobId);
    console.log("Job URL: ", settings.host + "/scheduler/job/" + jobId);
    console.log("Job state: " + spec.state + ", health: " + spec.health);

    if (settings.save_job_details) {
        const detailsBody = {
            id: jobId,
            state: spec.state,
            health: spec.health,
            submitter: spec.submitter,
            description: spec.description,
        };
        try {
            await saveJobDetails(detailsBody, jobId, settings.host, settings.test_job_file_name_prefix);
        } catch (err) {
            // Uploading the artifact only works on a runner. The file itself is
            // already written, so this must not abort the fake submission.
            console.log("Could not save job details artifact: " + err.message);
        }
    }

    if (spec.error) {
        const textFormat = BackgroundColor["error"];
        console.log(`${textFormat}Error retrieving job results: %s %s${ColorReset}`, spec.error.code, spec.error.message);
        if (settings.fail_action_on_incomplete) {
            console.log("Action failed because of job failure");
            core.setFailed("Error retrieving job results: " + spec.error.code + " " + spec.error.message);
        }
        return testResults;
    }

    for (const suite of spec.suites) {
        for (const testCase of suite.cases) {
            const textFormat = BackgroundColor["results"];
            console.log(`${textFormat}case: %s | definition: %s | result: %s ${ColorReset}`, testCase.name, suite.name, testCase.result);
            testResults.set(suite.name + "/" + testCase.name, testCase.result);
        }
    }

    console.log("Saving artifacts: " + settings.save_result_as_artifact);
    if (settings.result_file_name) {
        console.log("Saving to file: " + settings.result_file_name + ".xml")
    }
    const resultsBody = buildFakeJunit(spec);
    await saveResultsFile(jobId, resultsBody, settings.save_result_as_artifact, settings.result_file_name);

    await printResults(settings.fail_action_on_failure);

    if (spec.health === "Incomplete" || spec.health === "Canceled") {
        if (settings.fail_action_on_incomplete) {
            console.log("Action failed because of job failure");
            core.setFailed(spec.health);
        }
    }
    return testResults;
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

    const jobStatus = await jobStatusBody.json();
    const { state } = jobStatus;
    const { health } = jobStatus;

    if (state === "Submitted" || state === "Scheduled") {
        // Return if the job is in the queue
        return setTimeout(() => fetchAndParse(settings), 5000);
    }

    if (jobLogStatusCode >= 400) {
        console.log("Error retrieving job logs");
    }

    const jobLog = await jobLogBody.text();

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
    let fake_lava_submission;
    let fake_results;

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
        fake_lava_submission = core.getBooleanInput("fake_lava_submission", {required: false});
        fake_results = core.getInput("fake_results", {required: false});
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
        console.log("Fake LAVA submission: " + fake_lava_submission);
        if (fake_lava_submission) {
            console.log("Fake results spec: " + (fake_results ? "provided" : "default fixture"));
        }
    } catch (ex) {
        console.log("Error reading input variables");
        core.setFailed(ex.message);

        return;
    }

    const tokenString = "Token " + lava_token;
    const host = "https://" + lava_url;

    if ( fake_lava_submission ) {
        let spec;
        try {
            spec = parseFakeResults(fake_results);
        } catch (err) {
            console.log("Error parsing fake_results");
            // Problems with the environment are not the spec's fault, so they
            // are reported without the "fake_results" prefix.
            core.setFailed(err.message.startsWith("GITHUB_") ? err.message : "fake_results: " + err.message);

            return;
        }
        let settings = {
            spec: spec,
            host: host,
            fail_action_on_failure: fail_action_on_failure,
            fail_action_on_incomplete: fail_action_on_incomplete,
            save_result_as_artifact: save_result_as_artifact,
            result_file_name: result_file_name,
            save_job_details: save_job_details,
            test_job_file_name_prefix: test_job_file_name_prefix,
        }
        return await fakeSubmission(settings);
    }

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
        await saveJobDetails(detailsBody, jobId, host, test_job_file_name_prefix);
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
