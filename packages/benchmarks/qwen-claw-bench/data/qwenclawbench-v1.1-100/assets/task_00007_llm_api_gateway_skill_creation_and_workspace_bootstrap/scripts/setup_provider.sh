#!/bin/bash
# Setup external LLM provider for OpenClaw
# This script helps configure API credentials in .env

set -e

echo "=== OpenClaw External Provider Setup ==="
echo

read -p "Provider name (e.g. openai, anthropic): " PROVIDER
read -p "API Base URL: " BASE_URL
read -s -p "API Key: " API_KEY
echo

ENV_FILE="${HOME}/.openclaw/workspace/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Warning: .env file not found at $ENV_FILE"
  ENV_FILE=".env"
  echo "Using local .env: $ENV_FILE"
fi

PROVIDER_UPPER=$(echo "$PROVIDER" | tr '[:lower:]' '[:upper:]')

# Append or update
grep -q "^${PROVIDER_UPPER}_API_KEY=" "$ENV_FILE" 2>/dev/null && \
  sed -i "s|^${PROVIDER_UPPER}_API_KEY=.*|${PROVIDER_UPPER}_API_KEY=${API_KEY}|" "$ENV_FILE" || \
  echo "${PROVIDER_UPPER}_API_KEY=${API_KEY}" >> "$ENV_FILE"

grep -q "^${PROVIDER_UPPER}_BASE_URL=" "$ENV_FILE" 2>/dev/null && \
  sed -i "s|^${PROVIDER_UPPER}_BASE_URL=.*|${PROVIDER_UPPER}_BASE_URL=${BASE_URL}|" "$ENV_FILE" || \
  echo "${PROVIDER_UPPER}_BASE_URL=${BASE_URL}" >> "$ENV_FILE"

echo
echo "✅ Provider '$PROVIDER' configured in $ENV_FILE"
echo "   ${PROVIDER_UPPER}_BASE_URL=${BASE_URL}"
echo "   ${PROVIDER_UPPER}_API_KEY=sk-***${API_KEY: -4}"
echo
echo "Restart the gateway to apply: openclaw gateway restart"
