# LAVA job submit action

This action submits LAVA job to a LAVA instance

## Inputs

## `job_definition`

**Required** File path to fully rendered job definition

## `lava_token`

**Required** Authorization token from user able to submit test jobs.

## `lava_url`

**Required** URL of LAVA instance.

## `wait_for_job`

Wait for job completion and stream logs'

## `fail_action_on_failure`

Marks action failed in any test result is `fail`. Requires `wait_for_job` set to `true`

## `fail_action_on_incomplete`

Marks action failed in case test jobs ends as `Incomplete` or is `Canceled`

## `save_result_as_artifact`

Saves JUNIT file with test results. The file name is `test-resutls-<lava job ID>.xml`.
The file is saved to the top directory of the workflow artifacts.

## `save_job_details`

Saves LAVA job details retrieved from API as JSON file. Note that the file contains
full rendered job definition. It may contain sensitive data (like passwords).
Defaults to `false`

## `result_file_name`

The file name of the results pulled from LAVA API after the job is completed.
It can be used to overwrite the results when re-running the action in github workflow.
Defaults to `test-results-<jobID>`

## `test_job_file_name_prefix`

String that can be prepended to usual file name that contains job detail.
Default is empty string and the default name of the file is `test-job-<jobID>.json`
Prefix is added directly before the default name, so it is advised it ends with `-`

## `fake_lava_submission`

When set to `true` the action does not submit anything to LAVA. Instead it produces
a JUNIT results file (`test-results-<jobID>.xml` by default, or the name set with
`result_file_name`) in the same format a real LAVA `/junit/` response would have.
A random 6 digit job ID is generated for the fake submission.
If `save_job_details` is `true`, a matching `test-job-<jobID>.json` is produced as well.
This is useful for exercising the workflow that consumes this action without access to
a working LAVA instance. The fake results contain passing test cases, so
`fail_action_on_failure` will not fail the action. Defaults to `false`.

Note: `lava_token` and `lava_url` are still required inputs of the action, but any
dummy values can be used when `fake_lava_submission` is `true`.


## Example usage

    uses: foundries/lava-action@v3
    timeout-minutes: 10
    with:
      lava_token: '<auth token>'
      lava_url: 'example.lava.instance'
      job_definition: 'lavajob.yaml'
      wait_for_job: 'true'
      fail_action_on_failure: 'true'

Note! It is advised to set `timeout-minutes` to avoid the job runninng indefinitely.
