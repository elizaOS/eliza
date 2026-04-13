#!/bin/bash
set -euo pipefail

# =============================================================================
# EVM Benchmark Setup Script
#
# Sets up dependencies for running the EVM benchmark explorer.
# Works with Anvil (local) or any external EVM node (Hyperliquid EVM, etc.)
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "============================================================"
echo "  EVM Benchmark Setup"
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

# Check Foundry/Anvil
if ! command -v anvil &>/dev/null; then
    echo "  ⚠ Anvil not found."
    echo "    Install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup"
    echo ""
    echo "    Anvil is REQUIRED for local EVM benchmarking."
    echo "    For Hyperliquid EVM, you can use USE_EXTERNAL_NODE=true instead."
    echo ""
else
    echo "  ✓ Anvil: $(anvil --version 2>&1 | head -1 || echo 'installed')"
fi

# 2. Set up Python dependencies
echo ""
echo "Setting up Python dependencies..."
cd "$SCRIPT_DIR"

# Install Python packages needed by the benchmark
pip install aiohttp python-dotenv langchain langchain-openai 2>&1 | tail -5
echo "  ✓ Python dependencies installed"

# 3. Set up TypeScript (Bun) environment
echo ""
echo "Setting up TypeScript environment..."
cd "$SCRIPT_DIR/skill_runner"
echo "  Installing TypeScript dependencies with Bun..."
bun install 2>&1 | tail -5
echo "  ✓ TypeScript dependencies installed (viem)"
cd "$SCRIPT_DIR"

# 4. Set up environment variables
echo ""
echo "Setting up environment..."
if [ ! -f ".env" ]; then
    cat > .env << 'ENVEOF'
# EVM Benchmark Configuration

# OpenRouter API Key (required for LLM-assisted phase)
OPENROUTER_API_KEY=

# Chain configuration (general, hyperliquid)
CHAIN=general

# RPC URL (default: local Anvil)
RPC_URL=http://127.0.0.1:8545

# Chain ID (31337 for Anvil, 998 for Hyperliquid testnet)
CHAIN_ID=31337

# Agent private key (default: Anvil account #0)
# AGENT_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# Fork URL for mainnet fork (optional, requires Alchemy/Infura key)
# FORK_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY

# LLM model (prefix with provider: groq/, openai/, anthropic/)
MODEL_NAME=groq/qwen/qwen3-32b

# Max messages per run
MAX_MESSAGES=50

# Use external EVM node instead of local Anvil
USE_EXTERNAL_NODE=false
ENVEOF
    echo "  Created .env with defaults"
    echo "  ⚠ Edit .env and set OPENROUTER_API_KEY for LLM phase"
else
    echo "  ✓ .env already exists"
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
echo "To run the EVM benchmark:"
echo ""
echo "  # Full ElizaOS agent (recommended):"
echo "  USE_EXTERNAL_NODE=true MAX_MESSAGES=20 \\"
echo "    python -m benchmarks.evm.eliza_agent"
echo ""
echo "  # Standalone explorer (no ElizaOS, uses LangChain):"
echo "  USE_EXTERNAL_NODE=true python -m benchmarks.evm.eliza_explorer"
echo ""
echo "  # Hyperliquid EVM testnet:"
echo "  CHAIN=hyperliquid CHAIN_ID=998 USE_EXTERNAL_NODE=true \\"
echo "    RPC_URL=https://api.hyperliquid-testnet.xyz/evm \\"
echo "    AGENT_PRIVATE_KEY=your_private_key \\"
echo "    python -m benchmarks.evm.eliza_agent"
echo ""
echo "Environment variables:"
echo "  MODEL_NAME          LLM model (default: anthropic/claude-sonnet-4)"
echo "  MAX_MESSAGES        Messages per run (default: 50)"
echo "  OPENROUTER_API_KEY  Required for LLM phase"
echo "  CHAIN               general or hyperliquid (default: general)"
echo "  CHAIN_ID            31337 (Anvil) or 998 (HL testnet)"
echo "  RPC_URL             EVM node RPC URL"
echo "  FORK_URL            Optional: mainnet fork URL"
echo "  USE_EXTERNAL_NODE   true/false (default: false)"
echo "  AGENT_PRIVATE_KEY   Optional: custom agent key"
echo ""
