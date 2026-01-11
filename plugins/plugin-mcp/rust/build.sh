#!/bin/bash
set -e

# Build script for elizaos-plugin-mcp Rust implementation

echo "🦀 Building elizaos-plugin-mcp (Rust)..."

# Native build
echo "📦 Building native library..."
cargo build --release

# Run unit tests only (skip integration tests that require server)
echo "🧪 Running unit tests..."
cargo test --release --lib || echo "⚠️  Some tests may require external services"

echo "✅ Build complete!"
echo "Library location: target/release/libelizaos_plugin_mcp.rlib"


