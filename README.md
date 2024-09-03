# LAVA job submit action

This action submits LAVA job to a LAVA instance

## Inputs

## `job-definition`

**Required** Fully rendered LAVA job definition.

## `lava-token`

**Required** Authorization token from user able to submit test jobs.

## `lava-url`

**Required** URL of LAVA instance.

## Outputs

## `job-id`

The ID of a single node job or a list of IDs when submitting multi node job

## Example usage

uses: mwasilew/lava-action@v1
with:
  lava-token: '<auth token>'
  lava-url: 'https://example.lava.instance'
  job-definition: 'job_name: basic tests ...'
