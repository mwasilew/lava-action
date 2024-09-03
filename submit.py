#!/usr/bin/env python3

import os
import requests
import sys
from urllib.parse import urlparse

def main():
    token = ""
    lava_input_url = ""
    lava_job = ""
    lava_job_ids = ""

    token = os.environ["INPUT_LAVA-TOKEN"]
    lava_input_url = os.environ["INPUT_LAVA-URL"]
    lava_job = os.environ["INPUT_JOB-DEFINITION"]

    if not token:
        print("Token missing")
        sys.exit(1)

    if not lava_job:
        print("Job definition missing")
        sys.exit(1)

    # parse LAVA URL
    lava_url_parts = urlparse(lava_input_url)
    if not lava_url_parts.scheme:
        # exit with error
        print("Incorrect URL, schema missing")
        sys.exit(1)
    if not lava_url_parts.netloc:
        # exit with error
        print("Incorrect URL, location missing")
        sys.exit(1)
    lava_url = f"{lava_url_parts.scheme}://{lava_url_parts.netloc}/jobs/"
    authentication = {
        "Authorization": "Token %s" % token,
    }
    response = requests.post(
                lava_url,
                headers=authentication,
                data={"definition": lava_job}
                )

    if response.status_code == 201:
        lava_job_ids = response.json().get("job_ids")
    else:
        print("Error response from LAVA server")
        sys.exit(1)

    with open(os.path.abspath(os.environ["GITHUB_OUTPUT"]), "a") as output_file:
        output_file.write(f"job-id={lava_job_ids}")

if __name__ == "__main__":
    main()
