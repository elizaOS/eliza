#!/usr/bin/env bash
# OpenClaw Gateway Health Check Script
# Checks if the gateway is responding and restarts if necessary
#
# Usage: ./health-check.sh [--dry-run] [--verbose]
# Exit codes:
#   0 - Gateway is healthy
#   1 - Gateway was down, restart attempted
#   2 - Gateway failed to restart after max attempts

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/../config/gateway.conf"
LOG_DIR="${SCRIPT_DIR}/../logs"
LOG_FILE="${LOG_DIR}/health-check.log"

# Defaults (overridden by config)
GATEWAY_HOST="127.0.0.1"
GATEWAY_PORT=3578
HEALTH_ENDPOINT="/healthz"
TIMEOUT=5
MAX_RETRIES=3
RETRY_INTERVAL=2
MAX_RESTART_ATTEMPTS=3
RESTART_COOLDOWN=60
DRY_RUN=false
VERBOSE=false

# Parse arguments
for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=true ;;
    --verbose) VERBOSE=true ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

# Ensure log directory exists
mkdir -p "$LOG_DIR"

log() {
  local level="$1"
  shift
  local timestamp
  timestamp="$(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "[$timestamp] [$level] $*" | tee -a "$LOG_FILE"
}

log_verbose() {
  if [ "$VERBOSE" = true ]; then
    log "DEBUG" "$@"
  fi
}

# Parse config file if it exists
parse_config() {
  if [ -f "$CONFIG_FILE" ]; then
    log_verbose "Loading config from $CONFIG_FILE"
    GATEWAY_HOST=$(grep -E "^host\s*=" "$CONFIG_FILE" | head -1 | sed 's/.*=\s*//' | tr -d ' ')
    GATEWAY_PORT=$(grep -E "^port\s*=" "$CONFIG_FILE" | head -1 | sed 's/.*=\s*//' | tr -d ' ')
    HEALTH_ENDPOINT=$(grep -E "^endpoint\s*=" "$CONFIG_FILE" | head -1 | sed 's/.*=\s*//' | tr -d ' ')
    TIMEOUT=$(grep -E "^timeout_seconds\s*=" "$CONFIG_FILE" | head -1 | sed 's/.*=\s*//' | tr -d ' ')
    MAX_RETRIES=$(grep -E "^max_retries\s*=" "$CONFIG_FILE" | head -1 | sed 's/.*=\s*//' | tr -d ' ')
    RETRY_INTERVAL=$(grep -E "^retry_interval\s*=" "$CONFIG_FILE" | head -1 | sed 's/.*=\s*//' | tr -d ' ')
    MAX_RESTART_ATTEMPTS=$(grep -E "^max_restart_attempts\s*=" "$CONFIG_FILE" | head -1 | sed 's/.*=\s*//' | tr -d ' ')
    RESTART_COOLDOWN=$(grep -E "^restart_cooldown_seconds\s*=" "$CONFIG_FILE" | head -1 | sed 's/.*=\s*//' | tr -d ' ')
  else
    log "WARN" "Config file not found at $CONFIG_FILE, using defaults"
  fi
}

# Check gateway health
check_health() {
  local url="http://${GATEWAY_HOST}:${GATEWAY_PORT}${HEALTH_ENDPOINT}"
  log_verbose "Checking health at $url"

  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    --connect-timeout "$TIMEOUT" \
    --max-time "$TIMEOUT" \
    "$url" 2>/dev/null) || http_code="000"

  log_verbose "HTTP response code: $http_code"

  if [ "$http_code" = "200" ]; then
    return 0
  else
    return 1
  fi
}

# Check with retries
check_with_retries() {
  local attempt=1
  while [ $attempt -le "$MAX_RETRIES" ]; do
    if check_health; then
      return 0
    fi
    log_verbose "Health check attempt $attempt/$MAX_RETRIES failed, retrying in ${RETRY_INTERVAL}s..."
    sleep "$RETRY_INTERVAL"
    attempt=$((attempt + 1))
  done
  return 1
}

# Restart gateway
restart_gateway() {
  if [ "$DRY_RUN" = true ]; then
    log "INFO" "[DRY RUN] Would restart gateway"
    return 0
  fi

  log "INFO" "Attempting to restart OpenClaw gateway..."

  # Try openclaw CLI first
  if command -v openclaw &>/dev/null; then
    openclaw gateway restart 2>&1 | tee -a "$LOG_FILE"
    return $?
  fi

  # Fallback: try systemctl
  if command -v systemctl &>/dev/null; then
    sudo systemctl restart openclaw-gateway 2>&1 | tee -a "$LOG_FILE"
    return $?
  fi

  # Fallback: try the restart script
  local restart_script="${SCRIPT_DIR}/restart-gateway.sh"
  if [ -x "$restart_script" ]; then
    "$restart_script" 2>&1 | tee -a "$LOG_FILE"
    return $?
  fi

  log "ERROR" "No restart method available"
  return 1
}

# Main logic
main() {
  parse_config

  log "INFO" "Starting gateway health check (${GATEWAY_HOST}:${GATEWAY_PORT})"

  if check_with_retries; then
    log "INFO" "Gateway is healthy"
    exit 0
  fi

  log "WARN" "Gateway is not responding after $MAX_RETRIES attempts"

  local restart_attempt=1
  while [ $restart_attempt -le "$MAX_RESTART_ATTEMPTS" ]; do
    log "INFO" "Restart attempt $restart_attempt/$MAX_RESTART_ATTEMPTS"

    restart_gateway

    # Wait for gateway to come up
    log_verbose "Waiting ${RESTART_COOLDOWN}s for gateway to stabilize..."
    sleep "$RESTART_COOLDOWN"

    if check_with_retries; then
      log "INFO" "Gateway recovered after restart (attempt $restart_attempt)"
      exit 0
    fi

    log "WARN" "Gateway still not healthy after restart attempt $restart_attempt"
    restart_attempt=$((restart_attempt + 1))
  done

  log "ERROR" "Gateway failed to recover after $MAX_RESTART_ATTEMPTS restart attempts"
  exit 2
}

main
