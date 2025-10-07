#!/bin/bash

# Time Tracker Plugin Creator - Demo Version
# This script uses the elizaos CLI to generate a time tracking plugin
# Demo version with tests/validation skipped for faster execution

echo "==================================="
echo "ElizaOS Plugin Creator - DEMO"
echo "Time Tracker Plugin Example"
echo "==================================="
echo ""
echo "NOTE: This demo version skips tests and validation"
echo "      for faster execution. Use the full version"
echo "      for production-ready plugin generation."
echo ""

# For demo purposes, we'll check if API key is set but not require input
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "❌ ANTHROPIC_API_KEY not found in environment"
    echo ""
    echo "This demo requires an API key to be set:"
    echo "  export ANTHROPIC_API_KEY='your-api-key'"
    echo ""
    echo "For security, we don't prompt for keys in demo mode."
    exit 1
else
    echo "✓ API key found in environment"
fi

# Check if Claude Code is installed
echo ""
echo "Checking for Claude Code..."
if ! command -v claude &> /dev/null; then
    echo "❌ Claude Code not found!"
    echo "Please install it first: bun install -g @anthropic-ai/claude-code"
    exit 1
else
    CLAUDE_VERSION=$(claude --version 2>/dev/null || echo "unknown")
    echo "✓ Claude Code is installed (version: $CLAUDE_VERSION)"
fi

# Get the starting directory
START_DIR=$(pwd)

# Create logs directory with absolute path
LOG_DIR="$START_DIR/plugin-creator-demo-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"

echo ""
echo "Log directory: $LOG_DIR"
echo ""

# Find the CLI directory dynamically
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(dirname "$SCRIPT_DIR")"

# Check if we found a valid CLI directory
if [[ ! -f "$CLI_DIR/package.json" ]] || [[ ! -d "$CLI_DIR/dist" ]]; then
    echo "❌ Could not find ElizaOS CLI directory"
    echo "Expected structure: packages/cli/dist and packages/cli/package.json"
    echo "Make sure this script is run from the packages/cli/examples directory"
    echo "or that the CLI has been built (bun run build)"
    exit 1
fi

echo "✓ Found CLI directory: $CLI_DIR"

# Create spec file for demo with absolute path
SPEC_FILE="$LOG_DIR/time-tracker-spec.json"
cat > "$SPEC_FILE" << 'EOF'
{
  "name": "time-tracker",
  "description": "A plugin to display current time and manage timezone offsets for ElizaOS agents",
  "features": [
    "Display current time",
    "Set timezone offset",
    "Get time in different zones",
    "Format time strings",
    "Track elapsed time"
  ],
  "actions": ["displayTime", "setTimezoneOffset", "getTimeInZone"],
  "providers": ["currentTimeProvider", "timezoneProvider"]
}
EOF

echo "✓ Plugin specification created"
echo ""

# Run the plugin creator
echo "🚀 Starting DEMO plugin generation..."
echo "⚡ Skipping tests and validation for faster demo"
echo ""

# Execute with timestamp
START_TIME=$(date +%s)
cd "$CLI_DIR"
node dist/index.js plugins generate --skip-prompts --spec-file "$SPEC_FILE" --skip-tests --skip-validation 2>&1 | tee "$LOG_DIR/time-tracker.log"
RESULT=${PIPESTATUS[0]}
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo ""
echo "⏱️  Total execution time: ${ELAPSED} seconds"

# Check result
if [ $RESULT -eq 0 ]; then
    echo ""
    echo "✅ Demo completed successfully!"
    echo ""
    
    # Check if plugin was created
    EXPECTED_DIR="$CLI_DIR/plugin-time-tracker"
    if [ -d "$EXPECTED_DIR" ]; then
        echo "📁 Plugin created at: $EXPECTED_DIR"
        echo ""
        echo "📊 Plugin structure:"
        cd "$EXPECTED_DIR"
        find . -type f \( -name "*.ts" -o -name "*.json" -o -name "*.md" \) | grep -v node_modules | sort | head -20
        
        echo ""
        echo "📝 To use this plugin:"
        echo "1. cd $EXPECTED_DIR"
        echo "2. bun install"
        echo "3. bun run build"
        echo "4. bun test"
        echo ""
        echo "⚠️  Note: Since we skipped tests/validation in demo mode,"
        echo "   you should run full tests before using in production."
    else
        echo "⚠️  Plugin directory not found at expected location"
        echo "   Check the logs for the actual location"
    fi
else
    echo ""
    echo "❌ Demo failed. Check the log file: $LOG_DIR/time-tracker.log"
    echo ""
    echo "Common issues:"
    echo "- Invalid API key"
    echo "- Claude Code not properly installed"
    echo "- Network connectivity issues"
    echo "- Insufficient disk space"
fi

echo ""
echo "📋 Full log available at: $LOG_DIR/time-tracker.log" 