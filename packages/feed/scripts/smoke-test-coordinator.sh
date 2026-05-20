#!/usr/bin/env bash
#
# Smoke Test: Coordinator Endpoint
#
# Sends test messages to the coordinator API and validates response shape.
# Requires a running dev server and valid auth credentials.
#
# Usage:
#   # Set auth cookie from browser DevTools (Application > Cookies > privy-token)
#   export AUTH_COOKIE="privy-token=YOUR_TOKEN_HERE"
#   export TEAM_CHAT_ID="your-team-chat-id"
#   ./scripts/smoke-test-coordinator.sh
#
# What it tests:
#   1. Greeting fast-path (0 LLM calls)
#   2. Price query fast-path (CHECK_PERPS)
#   3. Portfolio fast-path (CHECK_USER_PNL)
#   4. Full LLM loop (general question)
#   5. Action verb bypass (should NOT fast-path)

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
ENDPOINT="${BASE_URL}/api/agents/team-chat/coordinator"

if [ -z "${AUTH_COOKIE:-}" ]; then
  echo "ERROR: Set AUTH_COOKIE env var (e.g., export AUTH_COOKIE='privy-token=...')"
  exit 1
fi

if [ -z "${TEAM_CHAT_ID:-}" ]; then
  echo "ERROR: Set TEAM_CHAT_ID env var"
  exit 1
fi

PASS=0
FAIL=0

send_message() {
  local label="$1"
  local content="$2"
  local expect_fast_path="${3:-}"  # Optional: expected fastPath value

  echo ""
  echo "--- Test: ${label} ---"
  echo "  Message: \"${content}\""

  local response
  response=$(curl -s -w "\n%{http_code}" \
    -X POST "${ENDPOINT}" \
    -H "Content-Type: application/json" \
    -H "Cookie: ${AUTH_COOKIE}" \
    -d "{\"content\": \"${content}\", \"teamChatId\": \"${TEAM_CHAT_ID}\"}")

  local http_code
  http_code=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | sed '$d')

  echo "  HTTP: ${http_code}"

  if [ "$http_code" != "200" ]; then
    echo "  FAIL: Expected 200, got ${http_code}"
    echo "  Body: ${body}"
    FAIL=$((FAIL + 1))
    return
  fi

  local success
  success=$(echo "$body" | jq -r '.success // "missing"')
  if [ "$success" != "true" ]; then
    echo "  FAIL: success=${success}"
    echo "  Body: ${body}"
    FAIL=$((FAIL + 1))
    return
  fi

  local resp_text
  resp_text=$(echo "$body" | jq -r '.response // "missing"')
  echo "  Response: ${resp_text:0:120}..."

  if [ -n "$expect_fast_path" ]; then
    local actual_fp
    actual_fp=$(echo "$body" | jq -r '.fastPath // "none"')
    if [ "$actual_fp" = "$expect_fast_path" ]; then
      echo "  fastPath: ${actual_fp} (expected)"
    else
      echo "  FAIL: expected fastPath=${expect_fast_path}, got ${actual_fp}"
      FAIL=$((FAIL + 1))
      return
    fi
  fi

  echo "  PASS"
  PASS=$((PASS + 1))
}

echo "========================================"
echo " Coordinator Smoke Test"
echo " Endpoint: ${ENDPOINT}"
echo "========================================"

# Test 1: Greeting fast-path
send_message "Greeting fast-path" "hello" "greeting"

# Test 2: Price query fast-path
send_message "Price query (CHECK_PERPS)" "show me TSLAI price" "CHECK_PERPS"

# Test 3: Portfolio fast-path
send_message "Portfolio query (CHECK_USER_PNL)" "what is my portfolio" "CHECK_USER_PNL"

# Test 4: Feed fast-path
send_message "Feed query (CHECK_FEED_POSTS)" "show me the feed" "CHECK_FEED_POSTS"

# Test 5: Full LLM loop (no fast-path)
send_message "General question (full LLM loop)" "what is Feed and how does it work"

# Test 6: Action verb bypass
send_message "Action verb bypass (should use LLM)" "buy TSLAI for 100 dollars"

echo ""
echo "========================================"
echo " Results: ${PASS} passed, ${FAIL} failed"
echo "========================================"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
