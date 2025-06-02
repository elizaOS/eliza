#!/bin/bash

# Simple Plugin Generator Example
# Demonstrates using elizaos CLI to generate a plugin

echo "==================================="
echo "ElizaOS Plugin Generator - Simple Example"
echo "==================================="
echo ""

# Check prerequisites
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "❌ Please set ANTHROPIC_API_KEY first:"
    echo "   export ANTHROPIC_API_KEY='your-api-key'"
    exit 1
fi

if ! command -v claude &> /dev/null; then
    echo "❌ Claude Code not found. Install with:"
    echo "   npm install -g @anthropic-ai/claude-code"
    exit 1
fi

echo "✓ Prerequisites checked"
echo ""

# Navigate to CLI directory
cd /Users/shawwalters/eliza/packages/cli

# For a quick demo, skip tests and validation
echo "Generating a time-tracker plugin (demo mode)..."
echo ""

# Prepare inputs for the interactive prompts
# Format: name, description, features, actions, providers
cat << 'EOF' | node dist/index.js plugins generate --skip-tests --skip-validation
time-tracker
A plugin to display current time and manage timezone offsets
Display time, Set timezone, Format time
displayTime, setOffset
timeProvider


EOF

echo ""
echo "Done! Check ./plugin-time-tracker for the generated plugin." 