#!/bin/bash
# Check GitHub CLI authentication status
# Returns 0 if authenticated, 1 otherwise

if ! command -v gh &> /dev/null; then
    echo "ERROR: gh CLI not installed"
    echo "Install: https://cli.github.com/"
    exit 1
fi

echo "Checking GitHub CLI auth status..."
gh auth status 2>&1

if [ $? -eq 0 ]; then
    echo "✓ Authenticated"
    exit 0
else
    echo "✗ Not authenticated — run: gh auth login"
    exit 1
fi
