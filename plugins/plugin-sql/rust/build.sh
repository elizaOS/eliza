#!/bin/bash
set -e

echo "Building elizaOS Plugin SQL Rust..."

# Build native library
echo "Building native library..."
cargo build --release

# Build WASM for web
echo "Building WASM for web..."
wasm-pack build --target web --out-dir pkg/web --features wasm

# Build WASM for Node.js
echo "Building WASM for Node.js..."
wasm-pack build --target nodejs --out-dir pkg/node --features wasm

# Run tests
echo "Running tests..."
cargo test

echo "Build complete!"
echo ""
echo "Outputs:"
echo "  - Native: target/release/libelizaos_plugin_sql.so (or .dylib on macOS, .dll on Windows)"
echo "  - WASM Web: pkg/web/"
echo "  - WASM Node.js: pkg/node/"

