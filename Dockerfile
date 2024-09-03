FROM python:3.11

RUN pip install requests

COPY submit.py /submit.py

ENTRYPOINT ["/submit.py"]

