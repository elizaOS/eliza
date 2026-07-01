#!/usr/bin/env bash
set -euo pipefail

# ── Config ───────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.gateway-webhook"
LOCAL_PORT="${LOCAL_PORT:-3002}"
NAMESPACE="eliza-infra"
SERVICE="gateway-webhook"
PROJECT="${PROJECT:-eliza-app}"
KUBE_CONTEXT="kind-eliza-local"

# ── Load env ─────────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found"
  exit 1
fi

source <(grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$' | sed 's/^/export /')

BOT_TOKEN="${ELIZA_APP_TELEGRAM_BOT_TOKEN:-}"
WEBHOOK_SECRET="${ELIZA_APP_TELEGRAM_WEBHOOK_SECRET:-}"
WA_VERIFY_TOKEN="${ELIZA_APP_WHATSAPP_VERIFY_TOKEN:-}"

# ── Cleanup on exit ──────────────────────────────────────────────
PIDS=()
cleanup() {
  echo ""
  echo "Shutting down..."

  # Unset Telegram webhook
  if [[ -n "$BOT_TOKEN" ]]; then
    echo "Removing Telegram webhook..."
    curl -s "https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook" | jq -r '.description // .result' 2>/dev/null || true
  fi

  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "Done."
}
trap cleanup EXIT INT TERM

# ── Prerequisites ────────────────────────────────────────────────
for cmd in kubectl ngrok curl jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd not found"
    exit 1
  fi
done

# Check pod is running
POD=$(kubectl --context "$KUBE_CONTEXT" get pods -n "$NAMESPACE" -l app="$SERVICE" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
if [[ -z "$POD" ]]; then
  echo "ERROR: No $SERVICE pod found in $NAMESPACE"
  exit 1
fi
echo "Found pod: $POD"

# ── Port-forward ─────────────────────────────────────────────────
echo "Port-forwarding $SERVICE:3000 → localhost:$LOCAL_PORT..."
kubectl --context "$KUBE_CONTEXT" port-forward -n "$NAMESPACE" "svc/$SERVICE" "$LOCAL_PORT:3000" &
PIDS+=($!)
sleep 2

# Verify it's up
if ! curl -sf "http://localhost:$LOCAL_PORT/health" >/dev/null 2>&1; then
  echo "ERROR: Health check failed on localhost:$LOCAL_PORT"
  exit 1
fi
echo "Health check OK"

# ── ngrok ────────────────────────────────────────────────────────
echo "Starting ngrok on port $LOCAL_PORT..."
ngrok http "$LOCAL_PORT" --log=stdout --log-level=warn &
PIDS+=($!)
sleep 3

# Get the public URL from ngrok API
NGROK_URL=$(curl -sf http://localhost:4040/api/tunnels | jq -r '.tunnels[] | select(.proto=="https") | .public_url' 2>/dev/null || true)
if [[ -z "$NGROK_URL" ]]; then
  echo "ERROR: Could not get ngrok URL. Is ngrok running?"
  exit 1
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  ngrok URL: $NGROK_URL"
echo "════════════════════════════════════════════════════════════════"

# ── Register Telegram webhook ────────────────────────────────────
if [[ -n "$BOT_TOKEN" ]]; then
  TG_WEBHOOK_URL="$NGROK_URL/webhook/$PROJECT/telegram"
  echo ""
  echo "Setting Telegram webhook → $TG_WEBHOOK_URL"

  ARGS="url=$TG_WEBHOOK_URL"
  if [[ -n "$WEBHOOK_SECRET" ]]; then
    ARGS="$ARGS&secret_token=$WEBHOOK_SECRET"
  fi

  RESULT=$(curl -sf "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" -d "$ARGS")
  echo "Telegram: $(echo "$RESULT" | jq -r '.description // .result')"
else
  echo ""
  echo "SKIP: No ELIZA_APP_TELEGRAM_BOT_TOKEN set"
fi

# ── WhatsApp instructions ────────────────────────────────────────
if [[ -n "$WA_VERIFY_TOKEN" ]]; then
  echo ""
  echo "── WhatsApp Cloud API ─────────────────────────────────────"
  echo "  Configure in Meta App Dashboard → WhatsApp → Configuration:"
  echo ""
  echo "  Callback URL:   $NGROK_URL/webhook/$PROJECT/whatsapp"
  echo "  Verify token:   $WA_VERIFY_TOKEN"
  echo ""
  echo "  Subscribe to: messages"
  echo "────────────────────────────────────────────────────────────"
fi

# ── Wait ─────────────────────────────────────────────────────────
echo ""
echo "Ready. Ctrl+C to stop and cleanup."
echo ""

# Tail pod logs
kubectl --context "$KUBE_CONTEXT" logs -n "$NAMESPACE" "$POD" -f 2>/dev/null || wait
