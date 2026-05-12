#!/usr/bin/env bash
# =============================================================================
# poly-arb-monitor-enhanced.sh
# Enhanced monitoring script for POL/USDC arbitrage operations
# Task ID: a2ce4b5b-63bf-4235-a84d-5a66cf18532f
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_FILE="${BASE_DIR}/config/monitor-config.json"
LOG_DIR="${BASE_DIR}/logs"
TX_LOG="${LOG_DIR}/transactions.log"
MONITOR_LOG="${LOG_DIR}/monitor.log"
ALERT_LOG="${LOG_DIR}/alerts.log"
STATE_FILE="${BASE_DIR}/data/monitor-state.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Ensure directories exist
mkdir -p "$LOG_DIR" "${BASE_DIR}/data"

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log() {
  local level="$1"
  shift
  echo "[$(timestamp)] [$level] $*" | tee -a "$MONITOR_LOG"
}

# Load config
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "ERROR: Config file not found: $CONFIG_FILE"
  exit 1
fi

HOT_WALLET=$(jq -r '.wallets.hot_wallet.address' "$CONFIG_FILE")
COLD_WALLET=$(jq -r '.wallets.cold_wallet.address' "$CONFIG_FILE")
RPC_PRIMARY=$(jq -r '.network.rpc_endpoints[0]' "$CONFIG_FILE")
RPC_FALLBACK=$(jq -r '.network.fallback_rpc' "$CONFIG_FILE")
POL_MIN=$(jq -r '.monitoring.balance_alert_thresholds.POL_min' "$CONFIG_FILE")
USDC_MIN=$(jq -r '.monitoring.balance_alert_thresholds.USDC_min' "$CONFIG_FILE")
POL_CRIT=$(jq -r '.monitoring.balance_alert_thresholds.POL_critical' "$CONFIG_FILE")
USDC_CRIT=$(jq -r '.monitoring.balance_alert_thresholds.USDC_critical' "$CONFIG_FILE")
GAS_MAX=$(jq -r '.monitoring.gas_price_max_gwei' "$CONFIG_FILE")
WEBHOOK=$(jq -r '.monitoring.alert_webhook' "$CONFIG_FILE")

USDC_CONTRACT=$(jq -r '.tokens.USDC.address' "$CONFIG_FILE")
USDC_DECIMALS=$(jq -r '.tokens.USDC.decimals' "$CONFIG_FILE")
POL_DECIMALS=$(jq -r '.tokens.POL.decimals' "$CONFIG_FILE")

# ----- RPC Call Helper -----
rpc_call() {
  local rpc_url="$1"
  local method="$2"
  local params="$3"
  
  local response
  response=$(curl -s --max-time 10 -X POST "$rpc_url" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"$method\",\"params\":$params,\"id\":1}" 2>/dev/null)
  
  if [[ -z "$response" ]] || echo "$response" | jq -e '.error' > /dev/null 2>&1; then
    return 1
  fi
  
  echo "$response" | jq -r '.result'
}

rpc_call_with_fallback() {
  local method="$1"
  local params="$2"
  
  local result
  result=$(rpc_call "$RPC_PRIMARY" "$method" "$params") && echo "$result" && return 0
  log "WARN" "Primary RPC failed, trying fallback..."
  result=$(rpc_call "$RPC_FALLBACK" "$method" "$params") && echo "$result" && return 0
  log "ERROR" "All RPC endpoints failed for $method"
  return 1
}

# ----- Balance Checks -----
check_pol_balance() {
  local wallet="$1"
  log "INFO" "Checking POL balance for ${wallet:0:10}..."
  
  local hex_balance
  hex_balance=$(rpc_call_with_fallback "eth_getBalance" "[\"$wallet\", \"latest\"]") || return 1
  
  # Convert hex to decimal and divide by 10^18
  local wei_balance
  wei_balance=$(python3 -c "print(int('${hex_balance}', 16))" 2>/dev/null || echo "0")
  local pol_balance
  pol_balance=$(python3 -c "print(f'{int(\"${hex_balance}\", 16) / 10**${POL_DECIMALS}:.4f}')" 2>/dev/null || echo "0.0000")
  
  echo "$pol_balance"
}

check_usdc_balance() {
  local wallet="$1"
  log "INFO" "Checking USDC balance for ${wallet:0:10}..."
  
  # ERC-20 balanceOf(address) selector: 0x70a08231
  local padded_addr
  padded_addr=$(printf '%064s' "${wallet:2}" | tr ' ' '0')
  local call_data="0x70a08231${padded_addr}"
  
  local hex_balance
  hex_balance=$(rpc_call_with_fallback "eth_call" "[{\"to\":\"$USDC_CONTRACT\",\"data\":\"$call_data\"}, \"latest\"]") || return 1
  
  local usdc_balance
  usdc_balance=$(python3 -c "print(f'{int(\"${hex_balance}\", 16) / 10**${USDC_DECIMALS}:.2f}')" 2>/dev/null || echo "0.00")
  
  echo "$usdc_balance"
}

# ----- Gas Price Check -----
check_gas_price() {
  log "INFO" "Checking current gas price..."
  
  local hex_gas
  hex_gas=$(rpc_call_with_fallback "eth_gasPrice" "[]") || return 1
  
  local gwei
  gwei=$(python3 -c "print(f'{int(\"${hex_gas}\", 16) / 10**9:.1f}')" 2>/dev/null || echo "0.0")
  
  echo "$gwei"
}

# ----- Transaction Log Monitor -----
monitor_tx_log() {
  log "INFO" "Scanning transaction log..."
  
  if [[ ! -f "$TX_LOG" ]]; then
    log "WARN" "Transaction log not found: $TX_LOG"
    return 0
  fi
  
  local total_txs
  total_txs=$(wc -l < "$TX_LOG" | tr -d ' ')
  
  # Count recent transactions (last 24h pattern: look for today's date)
  local today
  today=$(date -u +"%Y-%m-%d")
  local yesterday
  yesterday=$(date -u -d "yesterday" +"%Y-%m-%d" 2>/dev/null || date -u -v-1d +"%Y-%m-%d" 2>/dev/null || echo "")
  
  local recent_txs=0
  if [[ -n "$today" ]]; then
    recent_txs=$(grep -c "$today" "$TX_LOG" 2>/dev/null || echo "0")
  fi
  
  # Check for failed transactions
  local failed_txs
  failed_txs=$(grep -ci "FAILED\|REVERTED\|ERROR" "$TX_LOG" 2>/dev/null || echo "0")
  
  # Check for large trades
  local large_trades
  large_trades=$(grep -c "LARGE_TRADE" "$TX_LOG" 2>/dev/null || echo "0")
  
  # Summary
  log "INFO" "TX Log: total=$total_txs, recent_24h=$recent_txs, failed=$failed_txs, large=$large_trades"
  
  # Alert on high failure rate
  if [[ "$failed_txs" -gt 5 ]]; then
    send_alert "HIGH_FAILURE_RATE" "Found $failed_txs failed transactions in log"
  fi
  
  echo "{\"total\": $total_txs, \"recent_24h\": $recent_txs, \"failed\": $failed_txs, \"large_trades\": $large_trades}"
}

# ----- Alert System -----
send_alert() {
  local alert_type="$1"
  local message="$2"
  local ts
  ts=$(timestamp)
  
  echo "[$ts] [ALERT] [$alert_type] $message" >> "$ALERT_LOG"
  log "ALERT" "[$alert_type] $message"
  
  # Send to webhook if configured
  if [[ "$WEBHOOK" != "null" ]] && [[ "$WEBHOOK" != "" ]]; then
    curl -s -X POST "$WEBHOOK" \
      -H "Content-Type: application/json" \
      -d "{\"text\":\"🚨 *Arb Monitor Alert*\n*Type:* ${alert_type}\n*Message:* ${message}\n*Time:* ${ts}\"}" \
      > /dev/null 2>&1 || true
  fi
}

# ----- Main Execution -----
main() {
  log "INFO" "============================================"
  log "INFO" "Enhanced Arb Monitor starting..."
  log "INFO" "Task ID: a2ce4b5b-63bf-4235-a84d-5a66cf18532f"
  log "INFO" "============================================"
  
  local status="OK"
  local alerts=()
  
  # 1. Check POL balance
  local pol_bal
  pol_bal=$(check_pol_balance "$HOT_WALLET") || pol_bal="ERROR"
  if [[ "$pol_bal" == "ERROR" ]]; then
    status="DEGRADED"
    alerts+=("POL balance check failed")
  else
    log "INFO" "POL balance (hot): $pol_bal"
    if (( $(echo "$pol_bal < $POL_CRIT" | bc -l 2>/dev/null || echo 0) )); then
      send_alert "CRITICAL_BALANCE" "POL balance critically low: $pol_bal (threshold: $POL_CRIT)"
      status="CRITICAL"
    elif (( $(echo "$pol_bal < $POL_MIN" | bc -l 2>/dev/null || echo 0) )); then
      send_alert "LOW_BALANCE" "POL balance below minimum: $pol_bal (threshold: $POL_MIN)"
      status="WARNING"
    fi
  fi
  
  # 2. Check USDC balance
  local usdc_bal
  usdc_bal=$(check_usdc_balance "$HOT_WALLET") || usdc_bal="ERROR"
  if [[ "$usdc_bal" == "ERROR" ]]; then
    status="DEGRADED"
    alerts+=("USDC balance check failed")
  else
    log "INFO" "USDC balance (hot): $usdc_bal"
    if (( $(echo "$usdc_bal < $USDC_CRIT" | bc -l 2>/dev/null || echo 0) )); then
      send_alert "CRITICAL_BALANCE" "USDC balance critically low: $usdc_bal (threshold: $USDC_CRIT)"
      status="CRITICAL"
    elif (( $(echo "$usdc_bal < $USDC_MIN" | bc -l 2>/dev/null || echo 0) )); then
      send_alert "LOW_BALANCE" "USDC balance below minimum: $usdc_bal (threshold: $USDC_MIN)"
      status="WARNING"
    fi
  fi
  
  # 3. Check gas price
  local gas_price
  gas_price=$(check_gas_price) || gas_price="ERROR"
  if [[ "$gas_price" != "ERROR" ]]; then
    log "INFO" "Gas price: ${gas_price} Gwei"
    if (( $(echo "$gas_price > $GAS_MAX" | bc -l 2>/dev/null || echo 0) )); then
      send_alert "HIGH_GAS" "Gas price elevated: ${gas_price} Gwei (max: ${GAS_MAX})"
      [[ "$status" == "OK" ]] && status="WARNING"
    fi
  fi
  
  # 4. Monitor transaction logs
  local tx_stats
  tx_stats=$(monitor_tx_log)
  
  # 5. Update state file
  cat > "$STATE_FILE" <<EOF
{
  "last_run": "$(timestamp)",
  "status": "$status",
  "balances": {
    "POL": "$pol_bal",
    "USDC": "$usdc_bal"
  },
  "gas_price_gwei": "$gas_price",
  "tx_stats": $tx_stats,
  "alerts_count": ${#alerts[@]}
}
EOF
  
  log "INFO" "Monitor run complete. Status: $status"
  log "INFO" "State written to: $STATE_FILE"
  log "INFO" "============================================"
  
  # Exit code based on status
  case "$status" in
    OK) exit 0 ;;
    WARNING) exit 0 ;;
    DEGRADED) exit 1 ;;
    CRITICAL) exit 2 ;;
  esac
}

main "$@"
