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
    echo "   bun install -g @anthropic-ai/claude-code"
    exit 1
fi

echo "✓ Prerequisites checked"
echo ""

# Find the CLI directory dynamically
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(dirname "$SCRIPT_DIR")"

# Check if we found a valid CLI directory
if [[ ! -f "$CLI_DIR/package.json" ]] || [[ ! -d "$CLI_DIR/dist" ]]; then
    echo "❌ Could not find ElizaOS CLI directory"
    echo "Expected structure: packages/cli/dist and packages/cli/package.json"
    exit 1
fi

echo "✓ Found CLI directory: $CLI_DIR"

# Get the starting directory
START_DIR=$(pwd)

# Create a temporary spec file with absolute path
TEMP_DIR="$START_DIR/temp-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$TEMP_DIR"
SPEC_FILE="$TEMP_DIR/time-tracker-spec.json"

cat > "$SPEC_FILE" << 'EOF'
{
  "name": "time-tracker",
  "description": "A plugin to display current time and manage timezone offsets",
  "features": [
    "Display time",
    "Set timezone", 
    "Format time"
  ],
  "actions": ["displayTime", "setOffset"],
  "providers": ["timeProvider"]
}
EOF

echo "✓ Created plugin specification"

# For a quick demo, skip tests and validation
echo "Generating a time-tracker plugin (demo mode)..."
echo ""

# Run the generator with spec file
cd "$CLI_DIR"
node dist/index.js plugins generate --skip-prompts --spec-file "$SPEC_FILE" --skip-tests --skip-validation

# Clean up
rm -rf "$TEMP_DIR"

echo ""
echo "Done! Check $CLI_DIR/plugin-time-tracker for the generated plugin." 