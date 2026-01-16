#!/usr/bin/env bash
# Quick installer for ComputerUse CLI
# Usage (latest): curl -fsSL https://raw.githubusercontent.com/mediar-ai/computeruse/main/scripts/install.sh | bash
# Usage (specific): curl -fsSL https://raw.githubusercontent.com/mediar-ai/computeruse/main/scripts/install.sh | bash -s -- cli-v1.2.3
set -euo pipefail

REPO="mediar-ai/computeruse"
VERSION="${1:-}"  # optional first arg is tag like cli-v1.2.3

get_latest() {
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | head -n1 | cut -d '"' -f4
}

if [[ -z "$VERSION" ]]; then
  VERSION="$(get_latest)"
fi

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Linux) OS="linux" ;;
  Darwin) OS="macos" ;;
  *)
    echo "Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH="x86_64" ;;
  arm64|aarch64) ARCH="aarch64" ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

ARCHIVE="computeruse-cli-${OS}-${ARCH}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${ARCHIVE}"
echo "📦 Downloading $URL"
curl -L "${URL}" | tar -xz

chmod +x computeruse-cli
# Install to /usr/local/bin (may require sudo)
sudo mv computeruse-cli /usr/local/bin/computeruse-cli

echo "✅ ComputerUse CLI installed!"
echo ""
echo "📋 Next step: Run 'computeruse setup' to:"
echo "  • Install the Chrome extension automatically"
echo "  • Check system requirements"
echo "  • Configure SDKs and dependencies"
echo ""
echo "Then run 'computeruse --help' to see all available commands."