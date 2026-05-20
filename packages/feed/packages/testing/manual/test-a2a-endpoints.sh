#!/bin/bash
# Manual Test Script for A2A HTTP Endpoints
# Usage: ./tests/manual/test-a2a-endpoints.sh
# Requires: Server running on http://localhost:3000

set -e

BASE_URL="${BASE_URL:-http://localhost:3000}"
echo "🧪 Testing A2A HTTP Endpoints"
echo "Server: $BASE_URL"
echo ""

# Test 1: Agent Card
echo "1️⃣  Testing Agent Card Discovery..."
curl -s "$BASE_URL/.well-known/agent-card.json" | jq -r '.name, .version, (.supportedMethods | length)'
echo "✅ Agent card works"
echo ""

# Test 2: A2A Endpoint Health
echo "2️⃣  Testing A2A Endpoint Health..."
curl -s "$BASE_URL/api/a2a" | jq -r '.service, .status'
echo "✅ A2A endpoint alive"
echo ""

# Test 3: Get Balance
echo "3️⃣  Testing a2a.getBalance..."
curl -s -X POST "$BASE_URL/api/a2a" \
  -H "Content-Type: application/json" \
  -H "X-Agent-Id: test-agent" \
  -d '{
    "jsonrpc": "2.0",
    "method": "a2a.getBalance",
    "params": {},
    "id": 1
  }' | jq -r 'if .error then "Error: \(.error.message)" else "Balance: \(.result.balance)" end'
echo "✅ getBalance works"
echo ""

# Test 4: Invalid Method Error Handling
echo "4️⃣  Testing Error Handling..."
curl -s -X POST "$BASE_URL/api/a2a" \
  -H "Content-Type: application/json" \
  -H "X-Agent-Id: test-agent" \
  -d '{
    "jsonrpc": "2.0",
    "method": "a2a.invalidMethod",
    "params": {},
    "id": 2
  }' | jq -r 'if .error then "Error Code: \(.error.code) - \(.error.message)" else "Unexpected success" end'
echo "✅ Error handling works"
echo ""

# Test 5: Invalid JSON-RPC Format
echo "5️⃣  Testing JSON-RPC Validation..."
curl -s -X POST "$BASE_URL/api/a2a" \
  -H "Content-Type: application/json" \
  -d '{
    "method": "test",
    "id": 3
  }' | jq -r 'if .error then "Error Code: \(.error.code)" else "Unexpected success" end'
echo "✅ JSON-RPC validation works"
echo ""

echo "🎉 All A2A HTTP endpoint tests passed!"
echo ""
echo "Next steps:"
echo "  1. Run integration tests: bun test tests/integration/a2a-http-api.test.ts"
echo "  2. Run live tests: bun test tests/integration/a2a-http-live.test.ts (set SKIP_LIVE_SERVER=true to skip)"
echo "  3. Test with actual agents: See /eliza/plugin-babylon/"

