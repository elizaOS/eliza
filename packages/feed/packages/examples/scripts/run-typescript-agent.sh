#!/bin/bash
set -e

# Run the TypeScript example agent

echo "🤖 Starting TypeScript Example Agent"
echo "====================================="

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
EXAMPLES_DIR="$(dirname "$SCRIPT_DIR")"
AGENT_DIR="$EXAMPLES_DIR/babylon-typescript-agent"

# Check if A2A server is running
if ! curl -s http://localhost:3001/health > /dev/null 2>&1; then
    echo "❌ Error: A2A Server not running on port 3001"
    echo "   Run ./scripts/start-all.sh first"
    exit 1
fi

# Check if .env.local exists
if [ ! -f "$AGENT_DIR/.env.local" ]; then
    echo "Creating .env.local from example..."
    cat > "$AGENT_DIR/.env.local" << 'EOF'
# Babylon A2A Example Agent Configuration

# Agent wallet (uses anvil test account 0)
AGENT0_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# A2A Server (local)
BABYLON_API_URL=http://localhost:3001

# Agent Configuration
AGENT_NAME=Demo Agent
AGENT_DESCRIPTION=Autonomous trading agent for Babylon
AGENT_STRATEGY=balanced
TICK_INTERVAL=10000

# LLM Configuration (optional - will work without but decisions will be random)
# GROQ_API_KEY=your_groq_api_key
# ANTHROPIC_API_KEY=your_anthropic_api_key
# OPENAI_API_KEY=your_openai_api_key
EOF
    echo "✓ Created .env.local"
fi

cd "$AGENT_DIR"
echo "Installing dependencies..."
bun install --silent

echo ""
echo "Starting agent..."
echo ""
bun run agent
