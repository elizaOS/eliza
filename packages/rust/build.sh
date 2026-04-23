#!/bin/bash
set -e

echo "Building elizaOS Core Rust..."

# Build native library
echo "Building native library..."
cargo build --release

# Build WASM for web
echo "Building WASM for web..."
wasm-pack build --target web --out-dir pkg/web --no-default-features --features wasm
echo "✅ WASM web build succeeded"

# Build WASM for Node.js
echo "Building WASM for Node.js..."
wasm-pack build --target nodejs --out-dir pkg/node --no-default-features --features wasm
echo "✅ WASM Node.js build succeeded"

# Run tests
echo "Running tests..."
cargo test
echo "✅ Tests passed"

echo "Build complete!"
echo ""
echo "Outputs:"
echo "  - Native: target/release/libelizaos.so (or .dylib on macOS, .dll on Windows)"
echo "  - WASM Web: pkg/web/"
echo "  - WASM Node.js: pkg/node/"
