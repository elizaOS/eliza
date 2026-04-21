#!/bin/bash
set -euo pipefail

# =============================================================================
# Solana Benchmark Setup Script
#
# Sets up the solana-gym-env and all dependencies for running the Eliza
# benchmark explorer.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GYM_ENV_DIR="$SCRIPT_DIR/solana-gym-env"

echo "============================================================"
echo "  Solana Benchmark Setup"
echo "============================================================"

# 1. Check prerequisites
echo ""
echo "Checking prerequisites..."

# Check Python
if ! command -v python3 &>/dev/null; then
    echo "ERROR: python3 not found. Install Python 3.12+."
    exit 1
fi
echo "  ✓ Python: $(python3 --version)"

# Check uv
if ! command -v uv &>/dev/null; then
    echo "  ⚠ uv not found. Installing..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
fi
echo "  ✓ uv: $(uv --version)"

# Check Bun
if ! command -v bun &>/dev/null; then
    echo "  ⚠ Bun not found. Installing..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
fi
echo "  ✓ Bun: $(bun --version)"

# Check Surfpool
if ! command -v surfpool &>/dev/null; then
    echo "  ⚠ Surfpool not found."
    echo "    Install from: https://github.com/txtx/surfpool"
    echo "    Or: cargo install surfpool"
    echo ""
    echo "    Surfpool is REQUIRED for running the benchmark."
    echo "    The benchmark will fail without it."
    echo ""
else
    echo "  ✓ Surfpool: $(surfpool --version 2>&1 || echo 'installed')"
fi

# 2. Set up Python environment
echo ""
echo "Setting up Python environment..."
cd "$GYM_ENV_DIR"

if [ -f "pyproject.toml" ]; then
    echo "  Installing Python dependencies with uv..."
    uv sync 2>&1 | tail -5
    echo "  ✓ Python dependencies installed"
else
    echo "  Installing from requirements.txt..."
    uv pip install -r requirements.txt 2>&1 | tail -5
    echo "  ✓ Python dependencies installed"
fi

# Install additional adapter dependencies into the gym env venv
echo "  Installing benchmark adapter dependencies..."
uv add langchain langchain-openai python-dotenv solana base58 solders
echo "  ✓ Adapter dependencies installed"

# 3. Set up TypeScript (Bun) environment
echo ""
echo "Setting up TypeScript environment..."

# Use basic package.json by default
PACKAGE_JSON="voyager/environments/basic_package.json"
if [ -f "$PACKAGE_JSON" ]; then
    cp "$PACKAGE_JSON" voyager/skill_runner/package.json
    echo "  Using basic environment package.json"
fi

cd voyager/skill_runner
echo "  Installing TypeScript dependencies with Bun..."
bun install 2>&1 | tail -5
echo "  ✓ TypeScript dependencies installed"
cd "$GYM_ENV_DIR"

# 4. Set up environment variables
echo ""
echo "Setting up environment..."

if [ ! -f ".env" ] && [ -f ".env.example" ]; then
    cp .env.example .env
    echo "  Created .env from .env.example"
    echo "  ⚠ Please edit .env and set OPENROUTER_API_KEY"
elif [ -f ".env" ]; then
    echo "  ✓ .env already exists"
else
    echo "  ⚠ No .env file found. Create one with OPENROUTER_API_KEY."
fi

# 5. Create metrics directory
mkdir -p metrics
echo "  ✓ metrics/ directory ready"

# 6. Summary
echo ""
echo "============================================================"
echo "  Setup Complete!"
echo "============================================================"
echo ""
echo "To run the Eliza benchmark explorer:"
echo ""
echo "  # Option 1: With external surfpool (recommended)"
echo "  # Terminal 1:"
echo "  surfpool start -u https://api.mainnet-beta.solana.com --no-tui"
echo ""
echo "  # Terminal 2:"
echo "  cd $GYM_ENV_DIR"
echo "  USE_EXTERNAL_SURFPOOL=true ENVIRONMENT_CONFIG=voyager/environments/basic_env.json \\"
echo "    python -m benchmarks.solana.eliza_explorer"
echo ""
echo "  # Option 2: Auto-managed surfpool"
echo "  cd $GYM_ENV_DIR"
echo "  ENVIRONMENT_CONFIG=voyager/environments/basic_env.json \\"
echo "    python -m benchmarks.solana.eliza_explorer"
echo ""
echo "  # Run from workspace root:"
echo "  cd $(dirname "$SCRIPT_DIR")"
echo "  python -m benchmarks.solana.eliza_explorer"
echo ""
echo "Environment variables:"
echo "  MODEL_NAME          LLM model (default: anthropic/claude-sonnet-4)"
echo "  MAX_MESSAGES        Messages per run (default: 50)"
echo "  OPENROUTER_API_KEY  Required for LLM phase"
echo "  ENVIRONMENT_CONFIG  basic_env.json or swap_env.json"
echo "  USE_EXTERNAL_SURFPOOL  true/false"
echo ""
