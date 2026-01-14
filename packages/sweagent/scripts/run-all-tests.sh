#!/bin/bash
# Run all tests for sweagent across Python, TypeScript, and Rust

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "========================================"
echo "Running SWE-agent tests"
echo "========================================"

# Track failures
FAILED=0

# TypeScript tests
echo ""
echo "----------------------------------------"
echo "Running TypeScript tests..."
echo "----------------------------------------"
if [ -d "$ROOT_DIR/typescript" ] && [ -f "$ROOT_DIR/typescript/package.json" ]; then
    cd "$ROOT_DIR/typescript"
    if npx vitest run; then
        echo "✓ TypeScript tests passed"
    else
        echo "✗ TypeScript tests failed"
        FAILED=$((FAILED + 1))
    fi
else
    echo "⊘ TypeScript directory not found, skipping"
fi

# Rust tests
echo ""
echo "----------------------------------------"
echo "Running Rust tests..."
echo "----------------------------------------"
if [ -d "$ROOT_DIR/rust" ] && [ -f "$ROOT_DIR/rust/Cargo.toml" ]; then
    cd "$ROOT_DIR/rust"
    if cargo test; then
        echo "✓ Rust tests passed"
    else
        echo "✗ Rust tests failed"
        FAILED=$((FAILED + 1))
    fi
else
    echo "⊘ Rust directory not found, skipping"
fi

# Python tests
echo ""
echo "----------------------------------------"
echo "Running Python tests..."
echo "----------------------------------------"
if [ -d "$ROOT_DIR/python" ] && [ -f "$ROOT_DIR/python/pyproject.toml" ]; then
    cd "$ROOT_DIR/python"
    if pytest -p no:anchorpy --asyncio-mode=auto; then
        echo "✓ Python tests passed"
    else
        echo "✗ Python tests failed"
        FAILED=$((FAILED + 1))
    fi
else
    echo "⊘ Python directory not found, skipping"
fi

echo ""
echo "========================================"
if [ $FAILED -eq 0 ]; then
    echo "All tests passed!"
    exit 0
else
    echo "$FAILED test suite(s) failed"
    exit 1
fi
