#!/bin/bash
# Build elizaOS Plugin SQL for WASM

set -e

echo "Building elizaOS Plugin SQL for WASM..."

# Install wasm-pack if not present
if ! command -v wasm-pack &> /dev/null; then
    echo "Installing wasm-pack..."
    cargo install wasm-pack
fi

# Build for web target (bundler-compatible)
echo "Building for web target..."
wasm-pack build --target web --features wasm --no-default-features --out-dir pkg-web

# Build for Node.js target
echo "Building for Node.js target..."
wasm-pack build --target nodejs --features wasm --no-default-features --out-dir pkg-node

# Build for bundler target (webpack, etc.)
echo "Building for bundler target..."
wasm-pack build --target bundler --features wasm --no-default-features --out-dir pkg

echo "WASM build complete!"
echo "  - pkg/        : For bundlers (webpack, parcel, etc.)"
echo "  - pkg-web/    : For web browsers (ES modules)"
echo "  - pkg-node/   : For Node.js"

