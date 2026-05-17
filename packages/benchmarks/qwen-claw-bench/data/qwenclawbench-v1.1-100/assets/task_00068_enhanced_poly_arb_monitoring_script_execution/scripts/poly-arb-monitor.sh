#!/usr/bin/env bash
# poly-arb-monitor.sh — Enhanced POL/USDC Arbitrage Monitor
# Checks wallet balances, monitors transaction logs, and alerts on anomalies.
#
# Usage: ./poly-arb-monitor.sh [--dry-run] [--verbose]
# Cron: */15 * * * * /home/admin/clawd/scripts/poly-arb-monitor.sh >> /home/admin/clawd/logs/monitor-cron.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/../config/arb-config.json"
TX_LOG="${SCRIPT_DIR}/../logs/transactions.log"
BALANCE_CACHE="${SCRIPT_DIR}/../data/balance-cache.json"
ALERT_LOG="${SCRIPT_DIR}/../logs/alerts.log"

DRY_RUN=false
VERBOSE=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=true ;;
    --verbose)  VERBOSE=true ;;
  esac
done

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
vlog() { $VERBOSE && log "[VERBOSE] $*" || true; }

# ── Load config ──────────────────────────────────────────────────────
if [[ ! -f "$CONFIG_FILE" ]]; then
  log "ERROR: Config file not found: $CONFIG_FILE"
  exit 1
fi

RPC_URL=$(jq -r '.rpc.primary' "$CONFIG_FILE")
WALLET=$(jq -r '.wallet.address' "$CONFIG_FILE")
POL_MIN_BALANCE=$(jq -r '.thresholds.pol_min_balance' "$CONFIG_FILE")
USDC_MIN_BALANCE=$(jq -r '.thresholds.usdc_min_balance' "$CONFIG_FILE")
USDC_CONTRACT=$(jq -r '.contracts.usdc' "$CONFIG_FILE")
WETH_CONTRACT=$(jq -r '.contracts.weth' "$CONFIG_FILE")
ALERT_WEBHOOK=$(jq -r '.alerts.webhook_url // empty' "$CONFIG_FILE")
MAX_SLIPPAGE=$(jq -r '.thresholds.max_slippage_bps // 50' "$CONFIG_FILE")

vlog "RPC: $RPC_URL | Wallet: $WALLET"

# ── Helper: eth_call via JSON-RPC ────────────────────────────────────
eth_call() {
  local to="$1" data="$2"
  curl -sf -X POST "$RPC_URL" \
    -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_call\",\"params\":[{\"to\":\"$to\",\"data\":\"$data\"},\"latest\"],\"id\":1}" \
    | jq -r '.result'
}

eth_getBalance() {
  curl -sf -X POST "$RPC_URL" \
    -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getBalance\",\"params\":[\"$1\",\"latest\"],\"id\":1}" \
    | jq -r '.result'
}

hex_to_dec() {
  python3 -c "print(int('$1', 16))" 2>/dev/null || echo "0"
}

wei_to_ether() {
  python3 -c "print(f'{int(\"$1\", 16) / 1e18:.6f}')" 2>/dev/null || echo "0"
}

wei_to_usdc() {
  python3 -c "print(f'{int(\"$1\", 16) / 1e6:.2f}')" 2>/dev/null || echo "0"
}

# ── 1. Check POL (native) balance ────────────────────────────────────
log "Checking POL balance for $WALLET ..."
POL_RAW=$(eth_getBalance "$WALLET")
POL_BALANCE=$(wei_to_ether "$POL_RAW")
log "POL balance: $POL_BALANCE"

if (( $(echo "$POL_BALANCE < $POL_MIN_BALANCE" | bc -l) )); then
  ALERT_MSG="⚠️  LOW POL BALANCE: $POL_BALANCE POL (threshold: $POL_MIN_BALANCE)"
  log "$ALERT_MSG"
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $ALERT_MSG" >> "$ALERT_LOG"
fi

# ── 2. Check USDC (ERC-20) balance ──────────────────────────────────
BALANCE_OF_SIG="0x70a08231"
PADDED_WALLET=$(printf '%064s' "${WALLET#0x}" | tr ' ' '0')
CALLDATA="${BALANCE_OF_SIG}${PADDED_WALLET}"

log "Checking USDC balance ..."
USDC_RAW=$(eth_call "$USDC_CONTRACT" "$CALLDATA")
USDC_BALANCE=$(wei_to_usdc "$USDC_RAW")
log "USDC balance: $USDC_BALANCE"

if (( $(echo "$USDC_BALANCE < $USDC_MIN_BALANCE" | bc -l) )); then
  ALERT_MSG="⚠️  LOW USDC BALANCE: $USDC_BALANCE USDC (threshold: $USDC_MIN_BALANCE)"
  log "$ALERT_MSG"
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $ALERT_MSG" >> "$ALERT_LOG"
fi

# ── 3. Update balance cache ─────────────────────────────────────────
cat > "$BALANCE_CACHE" <<EOF
{
  "timestamp": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "wallet": "$WALLET",
  "balances": {
    "POL": $POL_BALANCE,
    "USDC": $USDC_BALANCE
  },
  "rpc": "$RPC_URL"
}
EOF
vlog "Balance cache updated: $BALANCE_CACHE"

# ── 4. Monitor transaction log ──────────────────────────────────────
if [[ -f "$TX_LOG" ]]; then
  LAST_HOUR=$(date -u -d '1 hour ago' '+%Y-%m-%dT%H:%M' 2>/dev/null || date -u -v-1H '+%Y-%m-%dT%H:%M')
  RECENT_TX=$(awk -v since="$LAST_HOUR" '$1 >= since' "$TX_LOG" | wc -l)
  FAILED_TX=$(awk -v since="$LAST_HOUR" '$1 >= since && /FAILED/' "$TX_LOG" | wc -l)
  HIGH_SLIP=$(awk -v since="$LAST_HOUR" -v max="$MAX_SLIPPAGE" '$1 >= since && /slippage_bps=/ {
    match($0, /slippage_bps=([0-9]+)/, a); if (a[1]+0 > max+0) count++
  } END { print count+0 }' "$TX_LOG")

  log "Last-hour transactions: $RECENT_TX | Failed: $FAILED_TX | High-slippage: $HIGH_SLIP"

  if [[ "$FAILED_TX" -gt 3 ]]; then
    ALERT_MSG="🚨 HIGH FAILURE RATE: $FAILED_TX failed txns in last hour"
    log "$ALERT_MSG"
    echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $ALERT_MSG" >> "$ALERT_LOG"
  fi

  if [[ "$HIGH_SLIP" -gt 2 ]]; then
    ALERT_MSG="📉 SLIPPAGE ALERT: $HIGH_SLIP txns exceeded ${MAX_SLIPPAGE}bps in last hour"
    log "$ALERT_MSG"
    echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $ALERT_MSG" >> "$ALERT_LOG"
  fi
else
  log "WARN: Transaction log not found: $TX_LOG"
fi

# ── 5. Gas price check ──────────────────────────────────────────────
GAS_HEX=$(curl -sf -X POST "$RPC_URL" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_gasPrice","params":[],"id":1}' \
  | jq -r '.result')
GAS_GWEI=$(python3 -c "print(f'{int(\"$GAS_HEX\", 16) / 1e9:.2f}')" 2>/dev/null || echo "?")
log "Current gas price: ${GAS_GWEI} gwei"

MAX_GAS=$(jq -r '.thresholds.max_gas_gwei // 500' "$CONFIG_FILE")
if (( $(echo "$GAS_GWEI > $MAX_GAS" | bc -l 2>/dev/null || echo 0) )); then
  ALERT_MSG="⛽ HIGH GAS: ${GAS_GWEI} gwei (max: ${MAX_GAS})"
  log "$ALERT_MSG"
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $ALERT_MSG" >> "$ALERT_LOG"
fi

# ── 6. Send webhook alert if configured ─────────────────────────────
if [[ -n "$ALERT_WEBHOOK" && -f "$ALERT_LOG" ]]; then
  NEW_ALERTS=$(tail -5 "$ALERT_LOG" 2>/dev/null)
  if [[ -n "$NEW_ALERTS" ]] && ! $DRY_RUN; then
    curl -sf -X POST "$ALERT_WEBHOOK" \
      -H 'Content-Type: application/json' \
      -d "{\"text\":\"Poly-Arb Monitor Alerts:\n$NEW_ALERTS\"}" || true
    vlog "Webhook sent to $ALERT_WEBHOOK"
  fi
fi

log "Monitor run complete."
