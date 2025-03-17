---
sidebar_position: 5
title: WSL Setup Guide
description: Guide for setting up Eliza on Windows using WSL (Windows Subsystem for Linux)
---

# WSL Setup Guide

Steps to run Eliza on Windows computer using WSL.
[AI Dev School Tutorial](https://www.youtube.com/watch?v=ArptLpQiKfI)

## Install WSL

1. Open PowerShell as Administrator and run:

```powershell
wsl --install
```

2. Restart your computer
3. Launch Ubuntu from the Start menu and create your Linux username/password

## Install Dependencies

1. Update Ubuntu packages:

```bash
sudo apt update && sudo apt upgrade -y
```

2. Install system dependencies:

```bash
sudo apt install -y \
    build-essential \
    python3 \
    python3-pip \
    git \
    curl \
    ffmpeg \
    libtool-bin \
    autoconf \
    automake \
    libopus-dev
```

3. Install Node.js via nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 23
nvm use 23
```

4. Install pnpm:

```bash
curl -fsSL https://get.pnpm.io/install.sh | sh -
source ~/.bashrc
```

## Optional: CUDA Support

If you have an NVIDIA GPU and want CUDA support:

1. Install CUDA Toolkit on Windows from [NVIDIA's website](https://developer.nvidia.com/cuda-downloads)
2. WSL will automatically detect and use the Windows CUDA installation

## Clone and Setup Eliza

Follow the [Quickstart Guide](../quickstart.md) starting from the "Installation" section.

## Troubleshooting

- If you encounter `node-gyp` errors, ensure build tools are installed:

```bash
sudo apt install -y nodejs-dev node-gyp
```

- For audio-related issues, verify ffmpeg installation:

```bash
ffmpeg -version
```

- For permission issues, ensure your user owns the project directory:

```bash
sudo chown -R $USER:$USER ~/path/to/eliza
```
