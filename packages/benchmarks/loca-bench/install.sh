#!/bin/bash
set -euo pipefail

# ====== Config ======
# Determine paths relative to this script's location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${SCRIPT_DIR}"
PROJECT_ROOT="${PROJECT_DIR}"

# Node config
NVM_VERSION="${NVM_VERSION:-v0.40.3}"
NODE_MAJOR="${NODE_MAJOR:-24}"

export DEBIAN_FRONTEND=noninteractive

# ====== Helpers ======
log() { echo -e "\n[install] $*\n"; }

# ====== 0) System dependencies ======
# Install python3-dev for building C extensions (e.g., pycosat)
log "Checking system dependencies..."

# Detect Python version for the correct -dev package
PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')

install_python_dev() {
  if command -v apt-get &> /dev/null; then
    # Debian/Ubuntu
    log "Installing python${PYTHON_VERSION}-dev (required for building C extensions)..."
    sudo apt-get update -qq
    sudo apt-get install -y python${PYTHON_VERSION}-dev build-essential
  elif command -v yum &> /dev/null; then
    # CentOS/RHEL
    log "Installing python3-devel (required for building C extensions)..."
    sudo yum install -y python3-devel gcc
  elif command -v dnf &> /dev/null; then
    # Fedora
    log "Installing python3-devel (required for building C extensions)..."
    sudo dnf install -y python3-devel gcc
  else
    log "WARNING: Could not detect package manager. Please install python3-dev manually."
  fi
}

# Check if Python.h exists
PYTHON_INCLUDE=$(python3 -c 'import sysconfig; print(sysconfig.get_path("include"))')
if [[ ! -f "${PYTHON_INCLUDE}/Python.h" ]]; then
  log "Python development headers not found at ${PYTHON_INCLUDE}"
  if command -v sudo &> /dev/null; then
    install_python_dev
  else
    log "ERROR: Python development headers missing and no sudo access."
    log "Please ask your administrator to install: python${PYTHON_VERSION}-dev"
    exit 1
  fi
else
  log "Python development headers found at ${PYTHON_INCLUDE}"
fi

# ====== 1) Python deps ======
# Use uv if available (faster), otherwise fall back to pip
if command -v uv &> /dev/null; then
  PIP_CMD="uv pip"
  log "Installing Python dependencies (uv)..."
else
  PIP_CMD="python -m pip"
  log "Installing Python dependencies (pip)..."
  python -m pip install --upgrade pip
fi

# Pre-install common deps MCP servers need
$PIP_CMD install --no-cache-dir \
  fire \
  python-dotenv \
  tiktoken \
  uv \
  reportlab \
  cryptography \
  ruff \
  black \
  pandas \
  numpy \
  pydantic-core \
  openpyxl \
  pillow

# Install the local project in editable mode (includes fastmcp, excel-mcp-server, etc.)
if [[ -d "$PROJECT_DIR" ]]; then
  log "Installing local project editable: $PROJECT_DIR"
  (cd "$PROJECT_DIR" && $PIP_CMD install -e .)
else
  log "WARNING: Project directory not found: $PROJECT_DIR"
  exit 1
fi

# ====== 2) nvm + Node ======
log "Installing nvm ($NVM_VERSION) and Node.js ($NODE_MAJOR)..."
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

# Install nvm if not already installed
if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  log "Installing nvm..."
  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash

  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    log "ERROR: nvm installation failed"
    exit 1
  fi
fi

# Load nvm
# shellcheck source=/dev/null
. "$NVM_DIR/nvm.sh"

# Install and configure Node.js
log "Installing Node.js v$NODE_MAJOR..."
nvm install "$NODE_MAJOR"
nvm use "$NODE_MAJOR"
nvm alias default "$NODE_MAJOR"

# Verify installation
if ! command -v node &> /dev/null; then
  log "ERROR: Node.js installation failed"
  exit 1
fi

# ====== 3) Create symlinks for easier access ======
log "Creating symlinks for node/npm/npx in ~/.local/bin..."
mkdir -p "$HOME/.local/bin"

# Dynamically get the actual installed node path
NODE_PATH="$(nvm which node)"
if [[ -z "$NODE_PATH" ]]; then
  log "ERROR: Could not determine node path"
  exit 1
fi

NODE_DIR="$(dirname "$NODE_PATH")"
log "Node.js installed at: $NODE_DIR"

# Create symlinks
ln -sf "$NODE_DIR/node" "$HOME/.local/bin/node"
ln -sf "$NODE_DIR/npm"  "$HOME/.local/bin/npm"
ln -sf "$NODE_DIR/npx"  "$HOME/.local/bin/npx"

# Update PATH for this session
export PATH="$HOME/.local/bin:$PATH"

# ====== 4) npm global packages ======
log "Installing npm global packages..."
npm install -g @modelcontextprotocol/server-filesystem @modelcontextprotocol/server-memory

# ====== 5) Pre-cache uvx tools ======
log "Pre-caching uvx tools (ignore failures)..."
uvx --help || true
uv tool install cli-mcp-server  || true
uv tool install pdf-tools-mcp  || true

log "Done ✅"
