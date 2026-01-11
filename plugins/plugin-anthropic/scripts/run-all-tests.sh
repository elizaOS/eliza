#!/bin/bash
set -e

# Run all tests for plugin-anthropic
#
# This script runs unit tests and integration tests for all three
# language implementations: TypeScript, Rust, and Python.
#
# Environment variables:
#   ANTHROPIC_API_KEY - Required for integration tests
#   SKIP_INTEGRATION  - Set to "true" to skip integration tests

echo "=================================================="
echo "Running plugin-anthropic tests"
echo "=================================================="

# Check for API key
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "⚠️  ANTHROPIC_API_KEY not set - integration tests will be skipped"
    SKIP_INTEGRATION=true
fi

# Track failures
FAILED=0

# TypeScript tests
echo ""
echo "🟦 TypeScript Tests"
echo "--------------------------------------------------"
cd "$(dirname "$0")/.."

echo "Running unit tests..."
if npx vitest run typescript/__tests__/unit/; then
    echo "✅ TypeScript unit tests passed"
else
    echo "❌ TypeScript unit tests failed"
    FAILED=1
fi

if [ "$SKIP_INTEGRATION" != "true" ]; then
    echo "Running integration tests..."
    if npx vitest run typescript/__tests__/integration/; then
        echo "✅ TypeScript integration tests passed"
    else
        echo "❌ TypeScript integration tests failed"
        FAILED=1
    fi
fi

# Rust tests
echo ""
echo "🦀 Rust Tests"
echo "--------------------------------------------------"
cd rust

echo "Running unit tests..."
if cargo test --features native; then
    echo "✅ Rust unit tests passed"
else
    echo "❌ Rust unit tests failed"
    FAILED=1
fi

if [ "$SKIP_INTEGRATION" != "true" ]; then
    echo "Running integration tests..."
    if cargo test --features native -- --ignored; then
        echo "✅ Rust integration tests passed"
    else
        echo "❌ Rust integration tests failed"
        FAILED=1
    fi
fi

cd ..

# Python tests
echo ""
echo "🐍 Python Tests"
echo "--------------------------------------------------"
cd python

echo "Running unit tests..."
if pytest -v --ignore=tests/test_integration.py; then
    echo "✅ Python unit tests passed"
else
    echo "❌ Python unit tests failed"
    FAILED=1
fi

if [ "$SKIP_INTEGRATION" != "true" ]; then
    echo "Running integration tests..."
    if pytest -m integration -v; then
        echo "✅ Python integration tests passed"
    else
        echo "❌ Python integration tests failed"
        FAILED=1
    fi
fi

cd ..

# Summary
echo ""
echo "=================================================="
if [ $FAILED -eq 0 ]; then
    echo "✅ All tests passed!"
else
    echo "❌ Some tests failed!"
    exit 1
fi


