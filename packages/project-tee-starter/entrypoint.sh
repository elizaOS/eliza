#!/bin/bash
set -e

echo "Installing system dependencies..."
apt-get update
apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    ffmpeg \
    git \
    make \
    python3 \
    unzip

apt-get clean
rm -rf /var/lib/apt/lists/*

echo "Installing bun..."
if ! command -v bun &> /dev/null; then
    npm install -g bun@1.2.5
fi

echo "Installing dependencies..."
bun install

echo "Building application..."
bun run build

echo "Starting application..."
exec bun run start