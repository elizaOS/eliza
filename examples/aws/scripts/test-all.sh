#!/bin/bash
# Test all AWS Lambda handlers (TypeScript, Python, Rust)
# Run from: examples/aws/

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AWS_DIR="$(dirname "$SCRIPT_DIR")"

echo "========================================"
echo "🧪 Testing ALL AWS Lambda Handlers"
echo "========================================"
echo ""

# TypeScript
echo "📘 TypeScript:"
echo "----------------------------------------"
cd "$AWS_DIR/typescript"
bun run test
echo ""

# Python
echo "🐍 Python:"
echo "----------------------------------------"
cd "$AWS_DIR/python"
python3 handler.py
echo ""

# Rust
echo "🦀 Rust:"
echo "----------------------------------------"
cd "$AWS_DIR/rust"
cargo run --bin test_local 2>&1 | grep -v "^warning:" | grep -v "Compiling\|Finished\|Running"
echo ""

echo "========================================"
echo "✅ ALL TESTS PASSED!"
echo "========================================"










