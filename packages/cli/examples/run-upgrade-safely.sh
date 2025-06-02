#!/bin/bash

# SAFE Plugin Upgrade Runner
# This script will read ANTHROPIC_API_KEY from .env files or environment

echo "==================================="
echo "Plugin Upgrade Runner"
echo "==================================="
echo ""

# Check for .env file and API key in parent directories
CURRENT_DIR="$(pwd)"
ENV_LOADED=false

while [ "$CURRENT_DIR" != "/" ]; do
    if [ -f "$CURRENT_DIR/.env" ]; then
        echo "Found .env file in $CURRENT_DIR, checking for API key..."
        if grep -q "ANTHROPIC_API_KEY" "$CURRENT_DIR/.env"; then
            echo "Found API key in .env file"
            # Source the .env file to get the key
            source "$CURRENT_DIR/.env"
            # Trim any whitespace from the API key
            ANTHROPIC_API_KEY=$(echo "$ANTHROPIC_API_KEY" | tr -d '[:space:]')
            # Ensure the key is exported
            export ANTHROPIC_API_KEY
            ENV_LOADED=true
            echo "✓ API key loaded from .env"
            break
        else
            echo "No API key found in .env file"
        fi
    fi
    CURRENT_DIR="$(dirname "$CURRENT_DIR")"
done

# Safety check - ensure we're not exposing keys
set +x  # Disable command echoing
export HISTFILE=/dev/null  # Disable history for this session

# Check if key is now available (either from environment or .env)
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "ERROR: ANTHROPIC_API_KEY not found in environment or .env files"
    echo ""
    echo "Please set your API key using ONE of these methods:"
    echo ""
    echo "Method 1 - Set for this session:"
    echo "  export ANTHROPIC_API_KEY='your-key'"
    echo "  ./run-upgrade-safely.sh"
    echo ""
    echo "Method 2 - Add to .env file:"
    echo "  echo 'ANTHROPIC_API_KEY=your-key' >> .env"
    echo "  ./run-upgrade-safely.sh"
    echo ""
    echo "Method 3 - Use direnv (recommended):"
    echo "  1. Install direnv: brew install direnv"
    echo "  2. Create .envrc with: export ANTHROPIC_API_KEY='your-key'"
    echo "  3. Run: direnv allow"
    echo "  4. Run this script"
    echo ""
    exit 1
fi

# Verify key format (basic check without exposing it)
if [[ ! "$ANTHROPIC_API_KEY" =~ ^sk-ant- ]]; then
    echo "Warning: API key doesn't appear to be in correct format"
    echo "Anthropic keys should start with 'sk-ant-'"
fi

# Run the actual upgrade
if [ "$ENV_LOADED" = true ]; then
    echo "Running upgrade with API key from .env file..."
else
    echo "Running upgrade with API key from environment variable..."
fi
echo "(API key is set but hidden for security)"
echo ""

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Attempt to remove stale lock file before running the upgrade
echo "Attempting to remove stale lock file from /tmp/plugin-giphy/.elizaos-migration.lock ..."
rm -f "/tmp/plugin-giphy/.elizaos-migration.lock"

# Export the API key to ensure it's available to the child script
export ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
"$SCRIPT_DIR/upgrade-giphy.sh"

# Note: The upgrade-giphy.sh script will clear the API key after use
echo ""
echo "Done. For security, please clear your API key if you set it manually:"
echo "  unset ANTHROPIC_API_KEY"