#!/usr/bin/env bash

# Run comprehensive tests for the start command
echo "Running comprehensive CLI start command tests..."

# Change to CLI directory
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Make sure we have the latest build
echo "Building CLI..."
bun run build

# Run the comprehensive test suite
echo "Running start command comprehensive tests..."
bun test bats/commands/start-comprehensive.bats

# Run the original start tests too
echo "Running original start command tests..."
bun test bats/commands/start.bats

echo "Test run complete!" 