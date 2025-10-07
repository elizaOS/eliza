#!/bin/bash

# Plugin Generator using elizaos CLI
# This script demonstrates using the elizaos CLI to generate plugins

echo "==================================="
echo "ElizaOS Plugin Generator"
echo "Using elizaos CLI"
echo "==================================="
echo ""

# Check if API key is already set
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "API key not found in environment."
    echo ""
    echo "Please set your API key first:"
    echo "  export ANTHROPIC_API_KEY='your-api-key'"
    echo ""
    echo "For automated/CI usage, you can also use:"
    echo "  ./create-plugin-cli.sh --api-key 'your-key'"
    echo ""
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
    echo "✓ Claude Code is installed"
fi

# Parse command line arguments
SKIP_TESTS=""
SKIP_VALIDATION=""
API_KEY_ARG=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-tests)
            SKIP_TESTS="--skip-tests"
            shift
            ;;
        --skip-validation)
            SKIP_VALIDATION="--skip-validation"
            shift
            ;;
        --api-key)
            API_KEY_ARG="--api-key $2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Get the starting directory
START_DIR=$(pwd)

# Create logs directory with absolute path
LOG_DIR="$START_DIR/plugin-generator-logs-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"

echo ""
echo "Starting plugin generation..."
echo "Log file: $LOG_DIR/plugin-generation.log"
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

# Create spec file for the plugin
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

# Build options string
OPTIONS="$SKIP_TESTS $SKIP_VALIDATION $API_KEY_ARG"

if [[ -n "$SKIP_TESTS" ]] || [[ -n "$SKIP_VALIDATION" ]]; then
    echo "Options: $OPTIONS"
    echo ""
fi

echo "Running elizaos plugin generate..."
echo ""

# Run the command with spec file
cd "$CLI_DIR"
node dist/index.js plugins generate --skip-prompts --spec-file "$SPEC_FILE" $OPTIONS 2>&1 | tee "$LOG_DIR/plugin-generation.log"

# Check if generation was successful
if [ ${PIPESTATUS[0]} -eq 0 ]; then
    echo ""
    echo "✅ Plugin generation completed!"
    echo ""
    
    # Check for the generated plugin
    if [ -d "$CLI_DIR/plugin-time-tracker" ]; then
        echo "Plugin created at: $CLI_DIR/plugin-time-tracker"
        echo ""
        echo "Plugin structure:"
        find "$CLI_DIR/plugin-time-tracker" -type f \( -name "*.ts" -o -name "*.json" -o -name "*.md" \) | grep -v node_modules | sort | head -20
        
        echo ""
        echo "Next steps:"
        echo "1. cd $CLI_DIR/plugin-time-tracker"
        echo "2. Review the generated code"
        echo "3. bun install && bun run build"
        echo "4. bun test"
    fi
else
    echo ""
    echo "❌ Plugin generation failed. Check the log file: $LOG_DIR/plugin-generation.log"
fi

# Clear API key from environment for security (if it was passed as argument)
if [[ -n "$API_KEY_ARG" ]]; then
    unset ANTHROPIC_API_KEY
    echo ""
    echo "✓ API key cleared from session"
fi 