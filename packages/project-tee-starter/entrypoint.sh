#!/bin/bash
set -e

# ============================================================================
# System Dependencies Installation
# ============================================================================

echo "📦 Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq \
    build-essential \
    curl \
    ffmpeg \
    wget \
    ca-certificates \
    gnupg \
    git \
    make \
    python3 \
    jq \
    unzip \
    > /dev/null 2>&1

echo "✅ System dependencies installed"

# ============================================================================
# Install Bun (JavaScript runtime)
# ============================================================================

if ! command -v bun &> /dev/null; then
    echo "📦 Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    echo "✅ Bun installed"
else
    echo "✅ Bun already installed"
fi

# ============================================================================
# Install Project Dependencies
# ============================================================================

echo "📦 Installing project dependencies..."
cd /app
bun install
echo "✅ Project dependencies installed"

# ============================================================================
# Build Project
# ============================================================================

echo "🔨 Building project..."
bun run build
echo "✅ Project built successfully"

# ============================================================================
# Start Project
# ============================================================================
echo "🚀 Starting application..."
exec bun run start