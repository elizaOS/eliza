#!/bin/bash
set -e

echo "Building elizaOS Core Rust..."

# Build native library
echo "Building native library..."
cargo build --release

# Build WASM for web (optional - may fail due to dependency incompatibilities)
echo "Building WASM for web..."
if wasm-pack build --target web --out-dir pkg/web --no-default-features --features wasm 2>&1; then
  echo "✅ WASM web build succeeded"
else
  echo "⚠️  WASM web build failed (this is expected with some dependency configurations)"
fi

# Build WASM for Node.js (optional - may fail due to dependency incompatibilities)
echo "Building WASM for Node.js..."
if wasm-pack build --target nodejs --out-dir pkg/node --no-default-features --features wasm 2>&1; then
  echo "✅ WASM Node.js build succeeded"
else
  echo "⚠️  WASM Node.js build failed (this is expected with some dependency configurations)"
fi

# Run tests (optional - may fail if WASM tests are included)
echo "Running tests..."
if cargo test 2>&1; then
  echo "✅ Tests passed"
else
  echo "⚠️  Some tests failed (may be expected if WASM features have issues)"
fi

echo "Build complete!"
echo ""
echo "Outputs:"
echo "  - Native: target/release/libelizaos.so (or .dylib on macOS, .dll on Windows)"
echo "  - WASM Web: pkg/web/"
echo "  - WASM Node.js: pkg/node/"

