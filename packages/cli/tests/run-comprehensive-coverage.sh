#!/usr/bin/env bash

# Run comprehensive coverage tests for ElizaOS CLI
# This script runs all the missing test scenarios identified

set -e

echo "================================================"
echo "ElizaOS CLI Comprehensive Test Coverage"
echo "================================================"
echo ""
echo "This will test:"
echo "  - Template creation and execution (project-starter, plugin-starter)"
echo "  - Plugin schema and migration"
echo "  - Monorepo vs standalone contexts"
echo "  - Process lifecycle and cleanup"
echo "  - Failure scenarios"
echo ""

# Change to CLI directory
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Ensure we have the latest build
echo "Building CLI..."
bun run build

# Check if BATS is installed
if ! command -v bats &> /dev/null; then
    echo "ERROR: BATS is not installed. Please install it first:"
    echo "  npm install -g bats"
    echo "  or"
    echo "  brew install bats-core"
    exit 1
fi

# Run the comprehensive test suite
echo ""
echo "Running comprehensive coverage tests..."
echo "================================================"

# Set timeout for the entire test suite (30 minutes)
export BATS_TEST_TIMEOUT=1800

# Run tests with detailed output
bats tests/bats/comprehensive-coverage.bats -t

# Check exit code
if [ $? -eq 0 ]; then
    echo ""
    echo "================================================"
    echo "✅ All comprehensive tests passed!"
    echo "================================================"
else
    echo ""
    echo "================================================"
    echo "❌ Some tests failed. Please check the output above."
    echo "================================================"
    exit 1
fi 