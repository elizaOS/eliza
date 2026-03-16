#!/usr/bin/env bash
# Build script for elizaos-plugin-solana Rust crate

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🦀 Building elizaos-plugin-solana..."

# Check for cargo
if ! command -v cargo &> /dev/null; then
    echo "❌ cargo not found. Please install Rust: https://rustup.rs"
    exit 1
fi

# Build the library
echo "📦 Building release..."
cargo build --release

# Run tests
echo "🧪 Running tests..."
cargo test

# Run clippy linting
echo "🔍 Running clippy..."
cargo clippy --all-targets -- -D warnings

echo "✅ Build complete!"
echo "   Library: target/release/libelizaos_plugin_solana.rlib"


