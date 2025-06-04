#!/bin/bash

# Time Tracker Plugin Creator
# This script uses the elizaos CLI to generate a time tracking plugin

echo "==================================="
echo "ElizaOS Plugin Creator"
echo "Time Tracker Plugin Example"
echo "==================================="
echo ""

# Check if API key is already set
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "API key not found in environment."
    echo ""
    echo "Please run this command first:"
    echo "  export ANTHROPIC_API_KEY='your-api-key'"
    echo ""
    echo "Or use the secure input method below:"
    echo ""
    
    # Secure API key input
    echo -n "Enter your Anthropic API key (input will be hidden): "
    read -s ANTHROPIC_API_KEY
    echo "" # New line after hidden input
    
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        echo "Error: No API key provided"
        exit 1
    fi
    
    export ANTHROPIC_API_KEY
    echo "✓ API key set for this session only"
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
    echo "✓ Claude Code is installed"
fi

# Get the starting directory
START_DIR=$(pwd)

# Create logs directory with absolute path
LOG_DIR="$START_DIR/plugin-creator-logs-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"

echo ""
echo "Starting plugin generation..."
echo "Log file: $LOG_DIR/time-tracker.log"
echo ""

# Find the CLI directory dynamically
# First, try to find it relative to this script
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

# Create spec file for the plugin
SPEC_FILE="$LOG_DIR/time-tracker-spec.json"
cat > "$SPEC_FILE" << 'EOF'
{
  "name": "time-tracker",
  "description": "A plugin to display current time and manage timezone offsets for ElizaOS agents",
  "features": [
    "Display current time in agent's response",
    "Set and manage timezone offset", 
    "Get time in different timezones",
    "Provide formatted time strings",
    "Track elapsed time between requests"
  ],
  "actions": ["displayTime", "setTimezoneOffset", "getTimeInZone"],
  "providers": ["currentTimeProvider", "timezoneProvider"]
}
EOF

echo "✓ Plugin specification created"

# Run the plugin creator using the CLI
echo "🚀 Running plugin creator..."
echo "This will:"
echo "  1. Create plugin structure"
echo "  2. Generate all code with AI" 
echo "  3. Run build and test loops"
echo "  4. Validate production readiness"
echo ""

# Execute the CLI command from the CLI directory
cd "$CLI_DIR"
node dist/index.js plugins generate --skip-prompts --spec-file "$SPEC_FILE" 2>&1 | tee "$LOG_DIR/time-tracker.log"

# Check result
if [ ${PIPESTATUS[0]} -eq 0 ]; then
    echo ""
    echo "✅ Plugin created successfully!"
    echo ""
    
    # The plugin should be in the CLI directory
    if [ -d "$CLI_DIR/plugin-time-tracker" ]; then
        echo "Plugin location: $CLI_DIR/plugin-time-tracker"
        echo ""
        echo "Next steps:"
        echo "1. cd $CLI_DIR/plugin-time-tracker"
        echo "2. Review the generated code"
        echo "3. bun test (to run tests)"
        echo "4. bun run build (to build)"
        echo "5. Add to your ElizaOS project"
    fi
else
    echo ""
    echo "❌ Plugin creation failed. Check the log file: $LOG_DIR/time-tracker.log"
    echo ""
    echo "Common issues:"
    echo "- Ensure ANTHROPIC_API_KEY is valid"
    echo "- Check that Claude Code is properly installed"
    echo "- Verify you have sufficient disk space"
fi

# Clear API key from environment for security
unset ANTHROPIC_API_KEY
echo ""
echo "✓ API key cleared from session" 