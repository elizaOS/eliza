_DOCKERFILE_BASE_JS = r"""
FROM --platform={platform} ubuntu:{ubuntu_version}

ARG DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC
RUN rm /bin/sh && ln -s /bin/bash /bin/sh

# Install necessary packages
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    git \
    libssl-dev \
    software-properties-common \
    wget \
    gnupg \
    jq \
    ca-certificates \
    dbus \
    ffmpeg \
    imagemagick \
    && apt-get -y autoclean \
    && rm -rf /var/lib/apt/lists/*

# Install Chrome
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg \
        fonts-khmeros fonts-kacst fonts-freefont-ttf libxss1 dbus dbus-x11 \
        --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install NVM
ENV NVM_DIR /usr/local/nvm

RUN mkdir -p $NVM_DIR
RUN curl --silent -o- https://raw.githubusercontent.com/creationix/nvm/v0.39.3/install.sh | bash

# Install necessary libraries for Chrome
RUN apt-get update && apt-get install -y \
    procps \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 \
    libgbm1 libgconf-2-4 libgdk-pixbuf2.0-0 libgtk-3-0 libnspr4 \
    libnss3 libpango-1.0-0 libpangocairo-1.0-0 libxcomposite1 \
    libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 libxss1 libxshmfence1 libglu1 \
    && apt-get -y autoclean \
    && rm -rf /var/lib/apt/lists/*

# Set up Chrome for running in a container
ENV CHROME_BIN /usr/bin/google-chrome
RUN echo "CHROME_BIN=$CHROME_BIN" >> /etc/environment

# Set DBUS for Chrome
RUN mkdir -p /run/dbus
ENV DBUS_SESSION_BUS_ADDRESS="unix:path=/run/dbus/system_bus_socket"
RUN dbus-daemon --system --fork

# If puppeteer is used, make it use the installed Chrome, not download its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Fix for PhantomJS runs (used by older task instances)
ENV OPENSSL_CONF /etc/ssl

# Add a non-root user to run Chrome
RUN useradd -m chromeuser
USER chromeuser
WORKDIR /home/chromeuser

# Switch back to root for any further commands
USER root
"""

_DOCKERFILE_ENV_JS = r"""FROM --platform={platform} {base_image_key}

ARG DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

COPY ./setup_env.sh /root/
RUN sed -i -e 's/\r$//' /root/setup_env.sh
RUN chmod +x /root/setup_env.sh

# Install Node
ENV NODE_VERSION {node_version}
RUN source $NVM_DIR/nvm.sh \
    && nvm install $NODE_VERSION \
    && nvm alias default $NODE_VERSION \
    && nvm use default

# Install Python
RUN add-apt-repository ppa:deadsnakes/ppa && apt-get update && apt-get install -y python{python_version}
RUN ln -s /usr/bin/python{python_version} /usr/bin/python

# Install Python2
RUN apt-get install -y python2

# Set up environment variables for Node
ENV NODE_PATH $NVM_DIR/v$NODE_VERSION/lib/node_modules
ENV PATH $NVM_DIR/versions/node/v$NODE_VERSION/bin:$PATH
RUN echo "PATH=$PATH:/usr/local/nvm/versions/node/$NODE_VERSION/bin/node" >> /etc/environment

# Install pnpm
ENV PNPM_VERSION {pnpm_version}
ENV PNPM_HOME /usr/local/pnpm
ENV PATH $PNPM_HOME:$PATH

RUN mkdir -p $PNPM_HOME && \
    wget -qO $PNPM_HOME/pnpm "https://github.com/pnpm/pnpm/releases/download/v$PNPM_VERSION/pnpm-linux-x64" && \
    chmod +x $PNPM_HOME/pnpm && \
    ln -s $PNPM_HOME/pnpm /usr/local/bin/pnpm

RUN echo "export PNPM_HOME=$PNPM_HOME" >> /etc/profile && \
    echo "export PATH=\$PNPM_HOME:\$PATH" >> /etc/profile

# Run the setup script
RUN /bin/bash -c "source ~/.bashrc && /root/setup_env.sh"
RUN node -v
RUN npm -v
RUN pnpm -v
RUN python -V
RUN python2 -V

WORKDIR /testbed/
"""

_DOCKERFILE_INSTANCE_JS = r"""FROM --platform={platform} {env_image_name}

COPY ./setup_repo.sh /root/
RUN sed -i -e 's/\r$//' /root/setup_repo.sh
RUN node -v
RUN npm -v
RUN /bin/bash /root/setup_repo.sh

WORKDIR /testbed/
"""

# We use a modern version of ubuntu as the base image because old node images
# can cause problems with agent installations. For eg. old GLIBC versions.
_DOCKERFILE_BASE_JS_2 = r"""
FROM --platform={platform} ubuntu:{ubuntu_version}

ARG DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

RUN apt update && apt install -y \
    wget \
    curl \
    git \
    build-essential \
    jq \
    gnupg \
    ca-certificates \
    apt-transport-https

# Install node
RUN bash -c "set -eo pipefail && curl -fsSL https://deb.nodesource.com/setup_{node_version}.x | bash -"
RUN apt-get update && apt-get install -y nodejs
RUN node -v && npm -v

# Install pnpm
RUN npm install --global corepack@latest
RUN corepack enable pnpm

# Install Chrome for browser testing
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Set up Chrome environment variables
ENV CHROME_BIN /usr/bin/google-chrome
ENV CHROME_PATH /usr/bin/google-chrome

RUN adduser --disabled-password --gecos 'dog' nonroot
"""
