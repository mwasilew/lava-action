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
If `save_job_details` is `true`, a matching `test-job-<jobID>.json` is produced as well.
This is useful for exercising the workflow that consumes this action without access to
a working LAVA instance. Defaults to `false`.

By default the fake submission reports two passing test cases in suite `0_fake-suite`,
so `fail_action_on_failure` will not fail the action. Use `fake_results` to control
what is returned.

`wait_for_job` is ignored for fake submissions - no logs are streamed and no job state
is polled, the results are produced immediately.

Note: `lava_token` and `lava_url` are still required inputs of the action, but any
dummy values can be used when `fake_lava_submission` is `true`.

## `fake_results`

Inline YAML (or JSON, which is valid YAML) describing what the fake submission should
return. Only used when `fake_lava_submission` is `true`, ignored otherwise. All keys are
optional:

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `job_id` | positive integer | derived, see below | pins the fake job ID exactly |
| `job_index` | integer 0-999 | `0` | separates matrix legs, see below |
| `state` | `Submitted`, `Scheduled`, `Running`, `Canceling`, `Finished` | `Finished` | recorded in the job details JSON |
| `health` | `Complete`, `Incomplete`, `Canceled`, `Unknown` | `Complete` | `Incomplete` and `Canceled` fail the action when `fail_action_on_incomplete` is `true` |
| `error` | string, or a mapping with `code` and `message` | none | simulate a failure to retrieve data from LAVA |
| `submitter` | string | `fake` | recorded in the job details JSON |
| `description` | string | `Fake LAVA job` | recorded in the job details JSON |
| `suites` | list of `{name, cases}` | two passing cases | the test results |

Each entry of `cases` is `{name, result, message}`, where `result` is one of `pass`,
`fail`, `skip` or `unknown` (default `pass`) and `message` is the text placed in the
JUNIT `<failure>`, `<skipped>` or `<error>` element.

A malformed spec fails the action with a `fake_results: <problem>` message naming the
offending field, before any file is written.

### Covering every outcome

`pass`, `fail` and `skip` results in one job. The `fail` case fails the action when
`fail_action_on_failure` is `true`; `skip` and `unknown` never do:

    with:
      fake_lava_submission: 'true'
      fake_results: |
        suites:
          - name: 0_smoke-tests
            cases:
              - {name: lscpu, result: pass}
              - {name: ip-addr, result: fail, message: 'no address assigned'}
              - {name: gpu, result: skip, message: 'hardware not present'}

A job that completes but produces no results at all. The JUNIT file is written and is a
valid, empty document:

    with:
      fake_lava_submission: 'true'
      fake_results: |
        suites: []

An incomplete (or canceled) job. Fails the action when `fail_action_on_incomplete` is
`true`:

    with:
      fake_lava_submission: 'true'
      fake_results: |
        health: Incomplete

An error while retrieving data from LAVA. Nothing is written to the results file, and the
action fails only when `fail_action_on_incomplete` is `true`:

    with:
      fake_lava_submission: 'true'
      fake_results: |
        error:
          code: 500
          message: Internal Server Error

### Fake job IDs

The results are fully repeatable: the same spec always produces the same test cases and
the same JUNIT file contents. The job ID is deliberately not, because it names the results
file and the workflow artifact, and reusing it would overwrite earlier results.

The ID is not hashed. It is packed from three deterministic counters, one decimal field
each:

    <GITHUB_RUN_NUMBER><GITHUB_RUN_ATTEMPT: 2 digits><job_index: 3 digits>

So run 42, attempt 1, matrix leg 3 is job ID `4201003`. Because the fields are packed
rather than mixed, the mapping is injective: two different (run, attempt, index) triples
can never produce the same ID. There is no collision probability to reason about.

`GITHUB_RUN_NUMBER` is unique per workflow run and unchanged by re-running, and
`GITHUB_RUN_ATTEMPT` increments on every re-run, so both are covered automatically.
`GITHUB_RUN_ID` is not used: it is around 11 digits and packing it would exceed the range
of integers JavaScript can represent exactly.

Matrix legs and repeated uses of this action within one workflow job are not visible in
the environment, so `job_index` has to be supplied. In a matrix, use the built-in
`strategy.job-index`:

    strategy:
      matrix:
        board: [imx8mm, rpi4]
    steps:
      - uses: foundries/lava-action@v3
        with:
          fake_lava_submission: 'true'
          fake_results: |
            job_index: ${{ strategy.job-index }}
            suites:
              - name: 0_smoke-tests
                cases:
                  - {name: lscpu, result: pass}

If the action runs more than once in the same job, give each step a distinct `job_index`.
Set `job_id` instead to pin an ID outright.

The action fails rather than risk a duplicate if `GITHUB_RUN_ATTEMPT` exceeds 99,
`job_index` is outside 0-999, or `GITHUB_RUN_NUMBER` is too large to pack.

Outside a runner both variables are unset, so `GITHUB_RUN_NUMBER` counts as `0` and
`GITHUB_RUN_ATTEMPT` as `1`: a local run of the default spec is always job `1000`.


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
