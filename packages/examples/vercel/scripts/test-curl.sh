#!/bin/bash
# Quick curl tests for elizaOS Vercel Edge Functions
#
# Usage:
#   ./scripts/test-curl.sh                    # Test local dev server
#   ./scripts/test-curl.sh https://your-app.vercel.app  # Test deployed

ENDPOINT="${1:-http://localhost:3000}"

echo "🧪 Quick curl tests for elizaOS Vercel Edge Functions"
echo "📍 Endpoint: $ENDPOINT"
echo ""

# Health check
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "1️⃣  Health check (GET /api/health)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
curl -s "$ENDPOINT/api/health" | jq .
echo ""

# Chat
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "2️⃣  Chat (POST /api/chat)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
curl -s -X POST "$ENDPOINT/api/chat" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello! What is 2 + 2?"}' | jq .
echo ""

# Validation error
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "3️⃣  Validation error (empty message)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
curl -s -X POST "$ENDPOINT/api/chat" \
  -H "Content-Type: application/json" \
  -d '{"message": ""}' | jq .
echo ""

# 404
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "4️⃣  404 (GET /api/unknown)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
curl -s "$ENDPOINT/api/unknown" | jq .
echo ""

echo "✅ Done!"










