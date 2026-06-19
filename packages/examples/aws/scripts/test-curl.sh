#!/bin/bash
# Quick test script for elizaOS AWS Lambda worker
# Usage: ./scripts/test-curl.sh <endpoint>

set -e

ENDPOINT="${1:-http://localhost:3000}"

echo "🧪 Testing elizaOS AWS Lambda Worker"
echo "📡 Endpoint: $ENDPOINT"
echo ""

# Health check
echo "1. Health Check..."
curl -s "$ENDPOINT/health" | jq .
echo ""

# Chat message
echo "2. Chat Message..."
curl -s -X POST "$ENDPOINT/chat" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello! What can you help me with today?"}' | jq .
echo ""

# Chat with conversation ID
echo "3. Continuation Message..."
CONV_ID=$(curl -s -X POST "$ENDPOINT/chat" \
  -H "Content-Type: application/json" \
  -d '{"message": "Tell me a joke"}' | jq -r '.conversationId')

echo "   Conversation ID: $CONV_ID"
curl -s -X POST "$ENDPOINT/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"That was funny! Tell me another.\", \"conversationId\": \"$CONV_ID\"}" | jq .
echo ""

echo "✅ Tests complete!"










