#!/bin/bash
set -e

# Build script for elizaos-plugin-mcp Rust implementation

echo "🦀 Building elizaos-plugin-mcp (Rust)..."

# Native build
echo "📦 Building native library..."
cargo build --release

# Run tests
echo "🧪 Running tests..."
cargo test --release

echo "✅ Build complete!"
echo "Library location: target/release/libelizaos_plugin_mcp.rlib"


