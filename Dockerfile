FROM python:3.11

RUN pip install requests

COPY submit.py /submit.py
RUN chmod a+x /submit.py

ENTRYPOINT ["/submit.py"]

