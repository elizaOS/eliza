#!/bin/bash
# Build elizaOS Core for WASM

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/scripts/ensure-wasm-tools.sh"

echo "Building elizaOS Core for WASM..."

# Build for Node.js target (default output to pkg/)
echo "Building for Node.js target..."
wasm-pack build --mode no-install --target nodejs --features wasm --no-default-features

# Copy to pkg-node for clarity
echo "Creating pkg-node directory..."
rm -rf pkg-node
cp -r pkg pkg-node

# Build for web target
echo "Building for web target..."
wasm-pack build --mode no-install --target web --features wasm --no-default-features

# Copy to pkg-web
echo "Creating pkg-web directory..."
rm -rf pkg-web
cp -r pkg pkg-web

# Build for bundler target (webpack, etc.) - final build in pkg/
echo "Building for bundler target..."
wasm-pack build --mode no-install --target bundler --features wasm --no-default-features

echo ""
echo "WASM build complete!"
echo "  - pkg/        : For bundlers (webpack, parcel, etc.)"
echo "  - pkg-web/    : For web browsers (ES modules)"
echo "  - pkg-node/   : For Node.js"
