#!/bin/bash

# Plugin-Giphy Upgrade Script
# Run this AFTER revoking your exposed API key and generating a new one

echo "==================================="
echo "Plugin-Giphy Upgrade Script"
echo "==================================="
echo ""

# Check if API key is already set
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "API key not found in environment."
    echo ""
    echo "Please run this command first:"
    echo "  export ANTHROPIC_API_KEY='your-new-api-key'"
    echo ""
    echo "Or use the secure input method below:"
    echo ""
    
    # Secure API key input
    echo -n "Enter your NEW Anthropic API key (input will be hidden): "
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

# Confirm before proceeding
echo ""
echo "Ready to upgrade plugin-giphy from:"
echo "  https://github.com/elizaos-plugins/plugin-giphy"
echo ""
echo "This will:"
echo "  1. Clone the repository (if needed)"
echo "  2. Create a new branch: 1.x-claude"
echo "  3. Apply migration changes"
echo "  4. Run tests (unless skipped)"
echo ""
# read -p "Continue? (y/n) " -n 1 -r
# echo ""

# if [[ ! $REPLY =~ ^[Yy]$ ]]; then
#     echo "Upgrade cancelled"
#     exit 0
# fi

# Create logs directory
LOG_DIR="./upgrade-logs-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"

echo ""
echo "Starting upgrade..."
echo "Log file: $LOG_DIR/plugin-giphy.log"
echo ""

# Run the upgrade
cd /Users/shawwalters/eliza/packages/cli
node dist/index.js plugins upgrade /tmp/plugin-giphy 2>&1 | tee "$LOG_DIR/plugin-giphy.log"

# Check result
if [ ${PIPESTATUS[0]} -eq 0 ]; then
    echo ""
    echo "✅ Upgrade completed successfully!"
    echo ""
    echo "Next steps:"
    echo "  1. cd /tmp/plugin-giphy"
    echo "  2. git diff main...1.x-claude  # Review changes"
    echo "  3. bun test                    # Run tests"
    echo "  4. git push origin 1.x-claude  # Push branch"
else
    echo ""
    echo "❌ Upgrade failed. Check the log file: $LOG_DIR/plugin-giphy.log"
fi

# Clear API key from environment for security
unset ANTHROPIC_API_KEY
echo ""
echo "✓ API key cleared from session" 