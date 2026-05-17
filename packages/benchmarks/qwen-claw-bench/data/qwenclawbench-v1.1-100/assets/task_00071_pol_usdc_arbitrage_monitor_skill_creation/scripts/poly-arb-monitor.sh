#!/usr/bin/env bash
#
# poly-arb-monitor.sh — Enhanced POL/USDC Arbitrage Monitor
# Checks wallet balances via Polygon RPC and monitors transaction logs
# for anomalies, failed txs, and profit/loss tracking.
#
# Usage: ./poly-arb-monitor.sh [--config PATH] [--verbose]
#
# Cron task: a2ce4b5b-63bf-4235-a84d-5a66cf18532f
# Schedule: every 15 minutes
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CONFIG_FILE="${PROJECT_ROOT}/config/monitor-config.json"
LOG_DIR="${PROJECT_ROOT}/logs"
REPORT_FILE="${LOG_DIR}/monitor-report-$(date +%Y%m%d).log"
VERBOSE=false

# --------------- argument parsing ---------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG_FILE="$2"; shift 2 ;;
    --verbose) VERBOSE=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# --------------- helpers ---------------
log() {
  local ts
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "[${ts}] $*" | tee -a "$REPORT_FILE"
}

log_verbose() {
  if $VERBOSE; then log "$@"; fi
}

die() { log "FATAL: $*"; exit 1; }

# --------------- load config ---------------
if [[ ! -f "$CONFIG_FILE" ]]; then
  die "Config not found: $CONFIG_FILE"
fi

RPC_URL=$(jq -r '.rpc_url' "$CONFIG_FILE")
WALLET=$(jq -r '.wallet_address' "$CONFIG_FILE")
POL_CONTRACT=$(jq -r '.contracts.POL' "$CONFIG_FILE")
USDC_CONTRACT=$(jq -r '.contracts.USDC' "$CONFIG_FILE")
BALANCE_WARN_POL=$(jq -r '.thresholds.pol_balance_warn // 50' "$CONFIG_FILE")
BALANCE_WARN_USDC=$(jq -r '.thresholds.usdc_balance_warn // 100' "$CONFIG_FILE")
PROFIT_TARGET_DAILY=$(jq -r '.thresholds.daily_profit_target // 25' "$CONFIG_FILE")
MAX_FAILED_TX=$(jq -r '.thresholds.max_failed_tx_per_hour // 3' "$CONFIG_FILE")
TX_LOG="${LOG_DIR}/$(jq -r '.tx_log_file // "transactions.log"' "$CONFIG_FILE")"
ALERT_WEBHOOK=$(jq -r '.alert_webhook // empty' "$CONFIG_FILE")

log "=== Enhanced Arbitrage Monitor Starting ==="
log "Wallet: ${WALLET:0:10}...${WALLET: -6}"
log "RPC: $RPC_URL"

# --------------- ERC-20 balance check ---------------
# balanceOf(address) selector: 0x70a08231
# Pad address to 32 bytes
get_erc20_balance() {
  local contract="$1"
  local symbol="$2"
  local decimals="$3"

  local padded_addr
  padded_addr="0x70a08231000000000000000000000000${WALLET:2}"

  local result
  result=$(curl -sf -X POST "$RPC_URL" \
    -H "Content-Type: application/json" \
    -d "{
      \"jsonrpc\": \"2.0\",
      \"method\": \"eth_call\",
      \"params\": [{
        \"to\": \"$contract\",
        \"data\": \"$padded_addr\"
      }, \"latest\"],
      \"id\": 1
    }" 2>/dev/null) || {
    log "ERROR: RPC call failed for $symbol balance"
    echo "0"
    return
  }

  local hex_val
  hex_val=$(echo "$result" | jq -r '.result // "0x0"')

  if [[ "$hex_val" == "null" || "$hex_val" == "0x" ]]; then
    log "WARN: Null result for $symbol — possible RPC issue"
    echo "0"
    return
  fi

  # Convert hex to decimal, then divide by 10^decimals
  local raw_balance
  raw_balance=$(python3 -c "print(int('$hex_val', 16))" 2>/dev/null || echo "0")
  local balance
  balance=$(python3 -c "print(round(int('$raw_balance') / 10**$decimals, 6))" 2>/dev/null || echo "0")

  echo "$balance"
}

log "--- Balance Check ---"
POL_BALANCE=$(get_erc20_balance "$POL_CONTRACT" "POL" 18)
USDC_BALANCE=$(get_erc20_balance "$USDC_CONTRACT" "USDC" 6)

log "POL  balance: $POL_BALANCE"
log "USDC balance: $USDC_BALANCE"

# Threshold alerts
if (( $(echo "$POL_BALANCE < $BALANCE_WARN_POL" | bc -l 2>/dev/null || echo 0) )); then
  log "⚠️  ALERT: POL balance ($POL_BALANCE) below threshold ($BALANCE_WARN_POL)"
fi

if (( $(echo "$USDC_BALANCE < $BALANCE_WARN_USDC" | bc -l 2>/dev/null || echo 0) )); then
  log "⚠️  ALERT: USDC balance ($USDC_BALANCE) below threshold ($BALANCE_WARN_USDC)"
fi

# --------------- transaction log analysis ---------------
log "--- Transaction Log Analysis ---"

if [[ ! -f "$TX_LOG" ]]; then
  log "WARN: Transaction log not found: $TX_LOG"
else
  TOTAL_TX=$(wc -l < "$TX_LOG" | tr -d ' ')
  log "Total logged transactions: $TOTAL_TX"

  # Count failed txs in last hour
  ONE_HOUR_AGO=$(date -u -d '1 hour ago' '+%Y-%m-%dT%H' 2>/dev/null || date -u -v-1H '+%Y-%m-%dT%H' 2>/dev/null || echo "")
  if [[ -n "$ONE_HOUR_AGO" ]]; then
    FAILED_RECENT=$(grep -c "FAILED" "$TX_LOG" | head -1 || echo "0")
    # More precise: filter by timestamp
    FAILED_HOUR=$(grep "$ONE_HOUR_AGO" "$TX_LOG" 2>/dev/null | grep -c "FAILED" || echo "0")
    log "Failed txs (last hour): $FAILED_HOUR"

    if (( FAILED_HOUR > MAX_FAILED_TX )); then
      log "🚨 CRITICAL: $FAILED_HOUR failed txs in last hour (threshold: $MAX_FAILED_TX)"
      log "Consider pausing the arbitrage bot!"
    fi
  fi

  # Daily P&L from tx log
  TODAY=$(date -u '+%Y-%m-%d')
  DAILY_PROFIT=$(grep "$TODAY" "$TX_LOG" 2>/dev/null | \
    grep "SUCCESS" | \
    awk -F'|' '{sum += $6} END {printf "%.4f", sum+0}' || echo "0.0000")
  log "Daily realized P&L (USDC): $DAILY_PROFIT"

  if (( $(echo "$DAILY_PROFIT >= $PROFIT_TARGET_DAILY" | bc -l 2>/dev/null || echo 0) )); then
    log "✅ Daily profit target reached: $DAILY_PROFIT / $PROFIT_TARGET_DAILY USDC"
  fi

  # Gas usage summary
  TOTAL_GAS=$(grep "$TODAY" "$TX_LOG" 2>/dev/null | \
    awk -F'|' '{sum += $7} END {printf "%.6f", sum+0}' || echo "0.000000")
  log "Daily gas spent (POL): $TOTAL_GAS"

  # Net profit after gas
  NET=$(python3 -c "print(round($DAILY_PROFIT - ($TOTAL_GAS * 0.45), 4))" 2>/dev/null || echo "0")
  log "Net profit after gas (est): $NET USDC"
fi

# --------------- pending tx check ---------------
log "--- Pending Transaction Check ---"
PENDING_COUNT=$(curl -sf -X POST "$RPC_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"eth_getTransactionCount\",
    \"params\": [\"$WALLET\", \"pending\"],
    \"id\": 1
  }" 2>/dev/null | jq -r '.result // "0x0"' || echo "0x0")

CONFIRMED_COUNT=$(curl -sf -X POST "$RPC_URL" \
  -H "Content-Type: application/json" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"eth_getTransactionCount\",
    \"params\": [\"$WALLET\", \"latest\"],
    \"id\": 1
  }" 2>/dev/null | jq -r '.result // "0x0"' || echo "0x0")

PENDING_NONCE=$(python3 -c "print(int('$PENDING_COUNT', 16))" 2>/dev/null || echo "0")
CONFIRMED_NONCE=$(python3 -c "print(int('$CONFIRMED_COUNT', 16))" 2>/dev/null || echo "0")
STUCK=$((PENDING_NONCE - CONFIRMED_NONCE))

log "Nonce (confirmed): $CONFIRMED_NONCE | Nonce (pending): $PENDING_NONCE"
if (( STUCK > 0 )); then
  log "⚠️  $STUCK stuck/pending transaction(s) detected"
fi

# --------------- summary ---------------
log "=== Monitor Complete ==="
log "POL=$POL_BALANCE | USDC=$USDC_BALANCE | DailyPnL=$DAILY_PROFIT | Gas=$TOTAL_GAS | Stuck=$STUCK"

# Send alert to webhook if configured
if [[ -n "${ALERT_WEBHOOK:-}" ]]; then
  PAYLOAD=$(jq -n \
    --arg pol "$POL_BALANCE" \
    --arg usdc "$USDC_BALANCE" \
    --arg pnl "$DAILY_PROFIT" \
    --arg gas "$TOTAL_GAS" \
    --arg stuck "$STUCK" \
    '{
      text: "Arb Monitor: POL=\($pol) USDC=\($usdc) PnL=\($pnl) Gas=\($gas) Stuck=\($stuck)"
    }')
  curl -sf -X POST "$ALERT_WEBHOOK" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" >/dev/null 2>&1 || log "WARN: Webhook delivery failed"
fi

exit 0
