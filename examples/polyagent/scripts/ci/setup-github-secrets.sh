#!/bin/bash

# GitHub Secrets Setup Script
# Automates adding secrets from .env.test to GitHub repository

set -e

echo "🔐 GitHub Secrets Setup"
echo "======================="
echo ""

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    echo "❌ GitHub CLI (gh) is not installed"
    echo ""
    echo "Install it first:"
    echo "  macOS:   brew install gh"
    echo "  Linux:   See https://cli.github.com/manual/installation"
    echo ""
    exit 1
fi

# Check if logged in
if ! gh auth status &> /dev/null; then
    echo "❌ Not logged into GitHub CLI"
    echo ""
    echo "Login first:"
    echo "  gh auth login"
    echo ""
    exit 1
fi

# Check if .env.test exists
if [ ! -f .env.test ]; then
    echo "❌ .env.test file not found"
    echo ""
    echo "Create it first:"
    echo "  cp env.test.template .env.test"
    echo "  # Edit .env.test with your test credentials"
    echo ""
    exit 1
fi

echo "✅ GitHub CLI is installed and authenticated"
echo "✅ .env.test file found"
echo ""

# Confirm before proceeding
read -p "This will add secrets from .env.test to your GitHub repository. Continue? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cancelled"
    exit 0
fi

echo ""
echo "📤 Adding secrets to GitHub..."
echo ""

# Function to add secret from env file
add_secret() {
    local key=$1
    local value=$(grep "^${key}=" .env.test | cut -d '=' -f2-)
    
    if [ -z "$value" ]; then
        echo "⚠️  Skipping $key (not set in .env.test)"
        return
    fi
    
    # Remove quotes if present
    value=$(echo "$value" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
    
    if gh secret set "$key" --body "$value" 2>/dev/null; then
        echo "✅ Added: $key"
    else
        echo "❌ Failed: $key"
    fi
}

# Required secrets
SECRETS=(
    "TEST_DATABASE_URL"
    "PRIVY_APP_ID"
    "NEXT_PUBLIC_PRIVY_APP_ID"
    "PRIVY_APP_SECRET"
    "PRIVY_TEST_EMAIL"
    "PRIVY_TEST_PASSWORD"
    "ANTHROPIC_API_KEY"
    "OPENAI_API_KEY"
    "WALLET_SEED_PHRASE"
    "WALLET_PASSWORD"
)

# Add each secret
for secret in "${SECRETS[@]}"; do
    add_secret "$secret"
done

echo ""
echo "🎉 Done!"
echo ""
echo "Next steps:"
echo "1. Verify secrets: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/settings/secrets/actions"
echo "2. Enable branch protection on main branch"
echo "3. Push a branch and create a PR to test CI"
echo ""

