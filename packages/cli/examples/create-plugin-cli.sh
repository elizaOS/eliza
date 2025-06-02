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
    echo "Please install it first: npm install -g @anthropic-ai/claude-code"
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

# Create logs directory
LOG_DIR="./plugin-generator-logs-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"

echo ""
echo "Starting plugin generation..."
echo "Log file: $LOG_DIR/plugin-generation.log"
echo ""

# Navigate to the CLI directory
cd /Users/shawwalters/eliza/packages/cli

# Build options string
OPTIONS="$SKIP_TESTS $SKIP_VALIDATION $API_KEY_ARG"

if [[ -n "$SKIP_TESTS" ]] || [[ -n "$SKIP_VALIDATION" ]]; then
    echo "Options: $OPTIONS"
    echo ""
fi

# Run the elizaos plugin generate command
# Note: Since the generate command is interactive by default, 
# we need to provide answers via a pipe or use --skip-prompts
# For this demo, we'll create an expect script or use echo to provide inputs

# Create an input file for the interactive prompts
INPUT_FILE="$LOG_DIR/inputs.txt"
cat > "$INPUT_FILE" << 'EOF'
time-tracker
A plugin to display current time and manage timezone offsets for ElizaOS agents
Display current time, Set timezone offset, Get time in different zones, Format time strings, Track elapsed time
displayTime, setTimezoneOffset, getTimeInZone
currentTimeProvider, timezoneProvider


EOF

echo "Running elizaos plugin generate..."
echo ""

# Run the command with inputs piped in
# Using the built CLI directly like upgrade-giphy.sh does
cat "$INPUT_FILE" | node dist/index.js plugins generate $OPTIONS 2>&1 | tee "$LOG_DIR/plugin-generation.log"

# Check if generation was successful
if [ ${PIPESTATUS[0]} -eq 0 ]; then
    echo ""
    echo "✅ Plugin generation completed!"
    echo ""
    
    # Check for the generated plugin
    if [ -d "plugin-time-tracker" ]; then
        echo "Plugin created at: ./plugin-time-tracker"
        echo ""
        echo "Plugin structure:"
        find plugin-time-tracker -type f \( -name "*.ts" -o -name "*.json" -o -name "*.md" \) | grep -v node_modules | sort | head -20
        
        echo ""
        echo "Next steps:"
        echo "1. cd plugin-time-tracker"
        echo "2. Review the generated code"
        echo "3. npm install && npm run build"
        echo "4. npm test"
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