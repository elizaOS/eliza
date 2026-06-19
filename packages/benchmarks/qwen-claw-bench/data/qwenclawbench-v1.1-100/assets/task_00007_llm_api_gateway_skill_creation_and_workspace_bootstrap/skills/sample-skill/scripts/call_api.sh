#!/bin/bash
# Generic API caller with retry logic
# Usage: ./call_api.sh <url> <api_key> <payload>

URL="${1:?URL required}"
API_KEY="${2:?API key required}"
PAYLOAD="${3:-{}}"
MAX_RETRIES=3
RETRY_DELAY=2

for i in $(seq 1 $MAX_RETRIES); do
  RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST "$URL" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD")

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
    echo "$BODY"
    exit 0
  elif [ "$HTTP_CODE" -eq 429 ]; then
    echo "Rate limited, retrying in ${RETRY_DELAY}s... (attempt $i/$MAX_RETRIES)" >&2
    sleep $RETRY_DELAY
    RETRY_DELAY=$((RETRY_DELAY * 2))
  else
    echo "Error: HTTP $HTTP_CODE" >&2
    echo "$BODY" >&2
    exit 1
  fi
done

echo "Max retries exceeded" >&2
exit 1
