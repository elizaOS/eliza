#!/bin/bash
set -e

# Babylon Example Agent Development Environment
# Start all services needed for local agent development

echo "🚀 Starting Babylon Agent Development Environment"
echo "=================================================="

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
EXAMPLES_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$EXAMPLES_DIR")"

# Check if data directory exists
mkdir -p "$EXAMPLES_DIR/local-a2a-server/data"
mkdir -p "$EXAMPLES_DIR/logs"

# Function to check if a port is in use
check_port() {
    if lsof -Pi :$1 -sTCP:LISTEN -t >/dev/null 2>&1; then
        return 0 # Port in use
    else
        return 1 # Port free
    fi
}

# Function to wait for a service
wait_for_service() {
    local url=$1
    local name=$2
    local max_attempts=30
    local attempt=1

    echo -n "Waiting for $name..."
    while [ $attempt -le $max_attempts ]; do
        if curl -s "$url" > /dev/null 2>&1; then
            echo -e " ${GREEN}Ready!${NC}"
            return 0
        fi
        echo -n "."
        sleep 1
        attempt=$((attempt + 1))
    done
    echo -e " ${RED}Failed${NC}"
    return 1
}

# Step 1: Start Anvil (local blockchain)
echo ""
echo -e "${YELLOW}Step 1: Starting Anvil (local blockchain)...${NC}"
if check_port 8545; then
    echo -e "${GREEN}✓ Anvil already running on port 8545${NC}"
else
    anvil --port 8545 --chain-id 31337 > "$EXAMPLES_DIR/logs/anvil.log" 2>&1 &
    echo $! > "$EXAMPLES_DIR/logs/anvil.pid"
    wait_for_service "http://localhost:8545" "Anvil"
fi

# Step 2: Start Local A2A Server
echo ""
echo -e "${YELLOW}Step 2: Starting Local A2A Server...${NC}"
if check_port 3001; then
    echo -e "${GREEN}✓ A2A Server already running on port 3001${NC}"
else
    cd "$EXAMPLES_DIR/local-a2a-server"
    bun install --silent
    bun run dev > "$EXAMPLES_DIR/logs/a2a-server.log" 2>&1 &
    echo $! > "$EXAMPLES_DIR/logs/a2a-server.pid"
    wait_for_service "http://localhost:3001/health" "A2A Server"
fi

# Step 3: Display status
echo ""
echo "=================================================="
echo -e "${GREEN}✓ All services started successfully!${NC}"
echo "=================================================="
echo ""
echo "Services:"
echo "  - Anvil (Blockchain):  http://localhost:8545"
echo "  - A2A Server:          http://localhost:3001"
echo "  - Agent Card:          http://localhost:3001/.well-known/agent-card"
echo "  - Health Check:        http://localhost:3001/health"
echo ""
echo "Test Wallets (from anvil):"
echo "  Account 0: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
echo "  Private:   0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
echo ""
echo "  Account 1: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
echo "  Private:   0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
echo ""
echo "To run the example agent:"
echo "  cd packages/examples/babylon-typescript-agent"
echo "  cp .env.example .env.local"
echo "  bun run agent"
echo ""
echo "To stop all services:"
echo "  ./scripts/stop-all.sh"
echo ""
