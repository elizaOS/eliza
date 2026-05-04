#!/usr/bin/env bash
# Quick curl tests for the elizaOS Convex agent.
#
# Usage:
#   CONVEX_URL=https://your-deployment.convex.cloud ./scripts/test-curl.sh

set -euo pipefail

CONVEX_URL="${CONVEX_URL:?Set CONVEX_URL to your Convex HTTP Actions URL}"
BASE="${CONVEX_URL%/}"

echo "=== Health Check ==="
curl -s "${BASE}/health" | jq .
echo ""

echo "=== Send Message ==="
CONV_ID="test-$(date +%s)"
curl -s -X POST "${BASE}/chat" \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"Hello! What can you help me with?\", \"conversationId\": \"${CONV_ID}\"}" \
  | jq .
echo ""

echo "=== Retrieve Messages ==="
curl -s "${BASE}/messages?conversationId=${CONV_ID}" | jq .
echo ""

echo "Done."
