FROM oven/bun:1.3.0-debian

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    unzip \
    zip \
    python3 \
    python3-pip \
    build-essential \
    ca-certificates \
    gnupg \
    lsb-release \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 (required for Hardhat / npx ecosystem)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Foundry (forge, cast, anvil)
ENV PATH="/root/.foundry/bin:${PATH}"
RUN curl -L https://foundry.paradigm.xyz | bash && foundryup

# uv (Python package manager, used by Python agent examples)
ENV PATH="/root/.local/bin:${PATH}"
RUN curl -LsSf https://astral.sh/uv/install.sh | sh

# Claude Code
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /workspace
