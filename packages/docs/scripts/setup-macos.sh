#!/bin/bash

# macOS Development Environment Setup Script
# Usage: curl -fsSL https://your-domain.com/setup.sh | bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get the shell profile file
get_shell_profile() {
    if [[ "$SHELL" == */zsh ]]; then
        echo "$HOME/.zprofile"
    elif [[ "$SHELL" == */bash ]]; then
        echo "$HOME/.bash_profile"
    else
        echo "$HOME/.profile"
    fi
}

SHELL_PROFILE=$(get_shell_profile)

# Helper function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running on macOS
if [[ "$(uname)" != "Darwin" ]]; then
    print_error "This script is designed for macOS only."
    exit 1
fi

print_status "Starting macOS development environment setup..."
print_status "Using shell profile: $SHELL_PROFILE"

# Function to add line to shell profile if not already present
add_to_profile() {
    local line="$1"
    if ! grep -Fxq "$line" "$SHELL_PROFILE" 2>/dev/null; then
        echo "$line" >> "$SHELL_PROFILE"
        print_success "Added to shell profile: $line"
    else
        print_warning "Already in shell profile: $line"
    fi
}

# 1. Install Homebrew if not present
print_status "Checking for Homebrew..."
if ! command -v brew &> /dev/null; then
    print_status "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    
    # Add Homebrew to PATH for Apple Silicon Macs
    if [[ $(uname -m) == "arm64" ]]; then
        BREW_PATH='export PATH="/opt/homebrew/bin:$PATH"'
        add_to_profile "$BREW_PATH"
        export PATH="/opt/homebrew/bin:$PATH"
    else
        # Intel Macs
        BREW_PATH='export PATH="/usr/local/bin:$PATH"'
        add_to_profile "$BREW_PATH"
        export PATH="/usr/local/bin:$PATH"
    fi
    
    print_success "Homebrew installed successfully"
else
    print_success "Homebrew is already installed"
fi

# Update Homebrew
print_status "Updating Homebrew..."
brew update

# 2. Install Node.js 23
print_status "Checking for Node.js 23..."
if brew list node@23 &>/dev/null; then
    print_success "Node.js 23 is already installed"
else
    print_status "Installing Node.js 23..."
    brew install node@23
    print_success "Node.js 23 installed successfully"
fi

# Add Node.js 23 to PATH
NODE_PATH='export PATH="/opt/homebrew/opt/node@23/bin:$PATH"'
if [[ $(uname -m) != "arm64" ]]; then
    NODE_PATH='export PATH="/usr/local/opt/node@23/bin:$PATH"'
fi
add_to_profile "$NODE_PATH"

# Export for current session
if [[ $(uname -m) == "arm64" ]]; then
    export PATH="/opt/homebrew/opt/node@23/bin:$PATH"
else
    export PATH="/usr/local/opt/node@23/bin:$PATH"
fi

# 3. Install Bun
print_status "Checking for Bun..."
if brew list bun &>/dev/null; then
    print_success "Bun is already installed"
else
    print_status "Installing Bun..."
    brew install bun
    print_success "Bun installed successfully"
fi

# Add Bun to PATH (Homebrew should handle this, but let's be explicit)
BUN_PATH='export PATH="$HOME/.bun/bin:$PATH"'
add_to_profile "$BUN_PATH"
export PATH="$HOME/.bun/bin:$PATH"

# Create shell profile if it doesn't exist
touch "$SHELL_PROFILE"

# Source the profile to apply changes
print_status "Applying shell profile changes..."
source "$SHELL_PROFILE" 2>/dev/null || true

# Verify installations
print_status "Verifying installations..."

echo ""
print_status "=== Installation Summary ==="

# Check Homebrew
if command -v brew &> /dev/null; then
    print_success "✓ Homebrew: $(brew --version | head -n1)"
else
    print_error "✗ Homebrew: Not found in PATH"
fi

# Check Node.js
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    if [[ "$NODE_VERSION" == v23* ]]; then
        print_success "✓ Node.js: $NODE_VERSION"
    else
        print_warning "⚠ Node.js: $NODE_VERSION (expected v23.x.x)"
        print_warning "  You may need to restart your terminal or run: source $SHELL_PROFILE"
    fi
else
    print_error "✗ Node.js: Not found in PATH"
fi

# Check npm
if command -v npm &> /dev/null; then
    print_success "✓ npm: $(npm --version)"
else
    print_error "✗ npm: Not found in PATH"
fi

# Check Bun
if command -v bun &> /dev/null; then
    print_success "✓ Bun: $(bun --version)"
else
    print_error "✗ Bun: Not found in PATH"
fi

echo ""
print_success "=== Setup Complete! ==="
print_warning "Please restart your terminal or run 'source $SHELL_PROFILE' to ensure all PATH changes take effect."

echo ""
print_status "Your shell profile ($SHELL_PROFILE) has been updated with the following:"
echo "  - Homebrew PATH"
echo "  - Node.js 23 PATH"
echo "  - Bun PATH"
