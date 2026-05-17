#!/usr/bin/env bash
#
# poly-arb-monitor.sh — Enhanced POL/USDC Arbitrage Monitor
# Checks wallet balances, monitors transaction logs, and alerts on anomalies.
#
# Usage: ./poly-arb-monitor.sh [--config <path>] [--verbose]
# Cron: a2ce4b5b-63bf-4235-a84d-5a66cf18532f
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Defaults
CONFIG_FILE="${ROOT_DIR}/config/monitor-config.json"
LOG_DIR="${ROOT_DIR}/logs"
DATA_DIR="${ROOT_DIR}/data"
VERBOSE=false

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG_FILE="$2"; shift 2 ;;
    --verbose) VERBOSE=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Load config
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "[ERROR] Config file not found: $CONFIG_FILE"
  exit 1
fi

RPC_URL=$(jq -r '.rpc_url' "$CONFIG_FILE")
WALLET_ADDRESS=$(jq -r '.wallet_address' "$CONFIG_FILE")
POL_CONTRACT=$(jq -r '.contracts.POL' "$CONFIG_FILE")
USDC_CONTRACT=$(jq -r '.contracts.USDC' "$CONFIG_FILE")
ALERT_THRESHOLD_POL=$(jq -r '.alert_thresholds.pol_min_balance' "$CONFIG_FILE")
ALERT_THRESHOLD_USDC=$(jq -r '.alert_thresholds.usdc_min_balance' "$CONFIG_FILE")
SLIPPAGE_WARN=$(jq -r '.alert_thresholds.slippage_warn_pct' "$CONFIG_FILE")
WEBHOOK_URL=$(jq -r '.notifications.webhook_url // empty' "$CONFIG_FILE")

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
LOG_FILE="${LOG_DIR}/monitor-$(date -u +%Y%m%d).log"

log() {
  local level="$1"; shift
  echo "[${TIMESTAMP}] [${level}] $*" | tee -a "$LOG_FILE"
}

# --- Balance Check (ERC-20 balanceOf via eth_call) ---
check_balance() {
  local token_name="$1"
  local contract="$2"
  local decimals="$3"

  # balanceOf(address) selector = 0x70a08231
  local padded_addr
  padded_addr=$(printf "0x70a08231%064s" "${WALLET_ADDRESS:2}" | tr ' ' '0')

  local result
  result=$(curl -sf -X POST "$RPC_URL" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_call\",\"params\":[{\"to\":\"${contract}\",\"data\":\"${padded_addr}\"},\"latest\"],\"id\":1}" \
    2>/dev/null)

  if [[ -z "$result" ]]; then
    log "ERROR" "RPC call failed for ${token_name} balance"
    return 1
  fi

  local hex_balance
  hex_balance=$(echo "$result" | jq -r '.result // "0x0"')
  local raw_balance
  raw_balance=$(python3 -c "print(int('${hex_balance}', 16))" 2>/dev/null || echo "0")

  local human_balance
  human_balance=$(python3 -c "print(round(int('${hex_balance}', 16) / 10**${decimals}, 6))" 2>/dev/null || echo "0")

  echo "$human_balance"
  log "INFO" "${token_name} balance: ${human_balance}"

  # Write to cache
  jq -n --arg token "$token_name" --arg bal "$human_balance" --arg ts "$TIMESTAMP" \
    '{token: $token, balance: ($bal | tonumber), timestamp: $ts}' \
    > "${DATA_DIR}/${token_name,,}-balance.json"
}

# --- Transaction Log Monitor ---
monitor_txlogs() {
  local tx_log="${LOG_DIR}/transactions.log"
  if [[ ! -f "$tx_log" ]]; then
    log "WARN" "Transaction log not found: ${tx_log}"
    return 0
  fi

  local recent_count
  recent_count=$(awk -v cutoff="$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -v-1H +%Y-%m-%dT%H:%M:%S 2>/dev/null || echo '1970-01-01T00:00:00')" \
    '$1 >= cutoff' "$tx_log" | wc -l)

  log "INFO" "Transactions in last hour: ${recent_count}"

  # Check for failed transactions
  local failed_count
  failed_count=$(grep -c "FAILED" "$tx_log" 2>/dev/null || echo "0")
  if [[ "$failed_count" -gt 0 ]]; then
    log "WARN" "Found ${failed_count} failed transactions in log"
  fi

  # Check for high slippage
  local high_slippage
  high_slippage=$(awk -F'|' -v threshold="$SLIPPAGE_WARN" \
    '{for(i=1;i<=NF;i++) if($i ~ /slippage=/) {split($i,a,"="); if(a[2]+0 > threshold+0) print}}' \
    "$tx_log" 2>/dev/null | wc -l)

  if [[ "$high_slippage" -gt 0 ]]; then
    log "WARN" "High slippage detected in ${high_slippage} transaction(s)"
  fi

  echo "${recent_count}|${failed_count}|${high_slippage}"
}

# --- Alert ---
send_alert() {
  local message="$1"
  if [[ -n "$WEBHOOK_URL" ]]; then
    curl -sf -X POST "$WEBHOOK_URL" \
      -H "Content-Type: application/json" \
      -d "{\"text\": \"[poly-arb-monitor] ${message}\"}" \
      >/dev/null 2>&1 || log "ERROR" "Webhook delivery failed"
  fi
  log "ALERT" "$message"
}

# --- Main ---
main() {
  log "INFO" "=== Enhanced Monitor Run Start ==="
  log "INFO" "Wallet: ${WALLET_ADDRESS}"
  log "INFO" "RPC: ${RPC_URL}"

  # Check POL balance
  local pol_balance
  pol_balance=$(check_balance "POL" "$POL_CONTRACT" 18) || pol_balance="ERROR"

  # Check USDC balance
  local usdc_balance
  usdc_balance=$(check_balance "USDC" "$USDC_CONTRACT" 6) || usdc_balance="ERROR"

  # Threshold alerts
  if [[ "$pol_balance" != "ERROR" ]]; then
    local pol_low
    pol_low=$(python3 -c "print(1 if float('${pol_balance}') < float('${ALERT_THRESHOLD_POL}') else 0)")
    if [[ "$pol_low" == "1" ]]; then
      send_alert "POL balance LOW: ${pol_balance} (threshold: ${ALERT_THRESHOLD_POL})"
    fi
  fi

  if [[ "$usdc_balance" != "ERROR" ]]; then
    local usdc_low
    usdc_low=$(python3 -c "print(1 if float('${usdc_balance}') < float('${ALERT_THRESHOLD_USDC}') else 0)")
    if [[ "$usdc_low" == "1" ]]; then
      send_alert "USDC balance LOW: ${usdc_balance} (threshold: ${ALERT_THRESHOLD_USDC})"
    fi
  fi

  # Monitor transaction logs
  local tx_stats
  tx_stats=$(monitor_txlogs)

  # Write summary
  jq -n \
    --arg ts "$TIMESTAMP" \
    --arg pol "${pol_balance}" \
    --arg usdc "${usdc_balance}" \
    --arg tx_stats "${tx_stats}" \
    --arg wallet "$WALLET_ADDRESS" \
    '{
      timestamp: $ts,
      wallet: $wallet,
      balances: {
        POL: ($pol | tonumber? // $pol),
        USDC: ($usdc | tonumber? // $usdc)
      },
      tx_stats: $tx_stats,
      status: "ok"
    }' > "${DATA_DIR}/latest-run.json"

  log "INFO" "=== Enhanced Monitor Run Complete ==="

  if $VERBOSE; then
    cat "${DATA_DIR}/latest-run.json"
  fi
}

main "$@"
