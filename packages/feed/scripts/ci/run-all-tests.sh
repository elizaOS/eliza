#!/bin/bash

# Run All Tests Script
# This script runs all tests in the correct order locally
# Mimics the CI environment for local testing

set -e  # Exit on any error

# Cleanup function
cleanup() {
    if [ ! -z "$SERVER_PID" ]; then kill $SERVER_PID 2>/dev/null || true; fi
    if [ ! -z "$CHAIN_PID" ]; then kill $CHAIN_PID 2>/dev/null || true; fi
}
trap cleanup EXIT

echo "🧪 Running Complete Test Suite"
echo "================================"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if .env.test exists
if [ ! -f .env.test ]; then
    echo -e "${YELLOW}⚠️  .env.test not found. Creating from .env.local${NC}"
    cp .env.local .env.test || {
        echo -e "${RED}❌ Failed to create .env.test${NC}"
        exit 1
    }
fi

# Copy test env
cp .env.test .env.local

echo ""
echo "📦 Step 1/7: Installing dependencies..."
bun install || {
    echo -e "${RED}❌ Failed to install dependencies${NC}"
    exit 1
}

echo ""
echo "🔧 Step 2/7: Pushing database schema with Drizzle..."
bunx drizzle-kit push --force || {
    echo -e "${RED}❌ Failed to push database schema${NC}"
    exit 1
}

echo ""
echo "🔍 Step 3/7: Type checking..."
bun typecheck || {
    echo -e "${RED}❌ Type check failed${NC}"
    exit 1
}

echo ""
echo "✨ Step 4/7: Linting..."
bun lint || {
    echo -e "${RED}❌ Lint failed${NC}"
    exit 1
}

echo ""
echo "🏗️  Step 5/7: Building production..."
bun run build || {
    echo -e "${RED}❌ Build failed${NC}"
    exit 1
}

echo ""
echo "🧪 Step 6/7: Running unit and integration tests..."
bun test tests/unit/ tests/integration/ tests/deployment/ tests/markets-pnl-sharing.test.ts || {
    echo -e "${RED}❌ Unit/Integration tests failed${NC}"
    exit 1
}

echo ""
echo "🎭 Step 7/7: Starting server and running E2E tests..."

# Check/Start local chain
if ! curl -s -H "Content-Type: application/json" -X POST --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' http://localhost:8545 > /dev/null; then
    echo "🔨 Starting Anvil..."
    anvil --host 0.0.0.0 --port 8545 --chain-id 31337 > /tmp/anvil.log 2>&1 &
    CHAIN_PID=$!
    echo "⏳ Waiting for Anvil..."
    timeout 30 bash -c 'until curl -s -H "Content-Type: application/json" -X POST --data "{\"jsonrpc\":\"2.0\",\"method\":\"eth_blockNumber\",\"params\":[],\"id\":1}" http://localhost:8545 > /dev/null; do sleep 1; done' || {
        echo -e "${RED}❌ Anvil failed to start${NC}"
        exit 1
    }
    echo "✅ Anvil is ready"
else
    echo "✅ Local chain is already running"
fi

# Start the server in the background
DEPLOYMENT_ENV=localnet NODE_ENV=production bun start &
SERVER_PID=$!

# Wait for server to be ready
echo "⏳ Waiting for server to start..."
timeout 120 bash -c 'until curl -f http://localhost:3000/api/health > /dev/null 2>&1; do sleep 2; done' || {
    echo -e "${RED}❌ Server failed to start${NC}"
    exit 1
}

echo -e "${GREEN}✅ Server is ready${NC}"

# Run Playwright tests
echo ""
echo "🎭 Running Playwright E2E tests..."
bunx playwright test tests/e2e --reporter=list || {
    echo -e "${RED}❌ Playwright tests failed${NC}"
    exit 1
}

# Run Chroma E2E tests
echo ""
echo "🧪 Running Chroma E2E tests..."
(cd tools/chroma && bunx playwright test --config=playwright.config.ts --reporter=list) || {
    echo -e "${RED}❌ Chroma E2E tests failed${NC}"
    exit 1
}

# Stop the server (handled by trap, but explicit message doesn't hurt)
echo "🛑 Stopping services..."

echo ""
echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}🎉 All tests passed!${NC}"
echo -e "${GREEN}================================${NC}"
echo ""
echo "✅ Build validation complete"
echo "✅ Unit tests passed"
echo "✅ Integration tests passed"
echo "✅ E2E tests passed"
echo "✅ Chroma E2E tests passed"
echo ""
echo "Your build is ready for production! 🚀"
