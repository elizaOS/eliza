#!/bin/bash
set -euo pipefail

# =============================================================================
# Steward Fleet Deployer
# Usage: ./scripts/deploy-all.sh [--migrate] [--restart]
#
# Deploys to milady (canary) first, then core-1 through core-6.
# Aborts if canary fails.
# =============================================================================

GREEN='\033[32m'
RED='\033[31m'
YELLOW='\033[33m'
CYAN='\033[36m'
BOLD='\033[1m'
RESET='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SCRIPT="$SCRIPT_DIR/deploy.sh"

# ---------------------------------------------------------------------------
# Nodes: milady (canary) first, then agents
# ---------------------------------------------------------------------------
declare -A NODES
NODES=(
  [milady]="89.167.63.246"
  [core-1]="88.99.66.168"
  [core-2]="178.63.251.122"
  [core-3]="138.201.80.125"
  [core-4]="85.10.193.52"
  [core-5]="136.243.47.243"
  [core-6]="195.201.57.227"
)

# Ordered deploy sequence
NODE_ORDER=(milady core-1 core-2 core-3 core-4 core-5 core-6)

# ---------------------------------------------------------------------------
# Forward flags to deploy.sh
# ---------------------------------------------------------------------------
EXTRA_FLAGS=()
DO_MIGRATE=false

for arg in "$@"; do
  case "$arg" in
    --migrate)  EXTRA_FLAGS+=("--migrate"); DO_MIGRATE=true ;;
    --restart)  EXTRA_FLAGS+=("--restart") ;;
    -h|--help)
      echo "Usage: $0 [--migrate] [--restart]"
      echo "  --migrate  Run DB migrations (only on canary node)"
      echo "  --restart  Restart steward services after deploy"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg"
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Results tracking
# ---------------------------------------------------------------------------
declare -A RESULTS
declare -A VERSIONS

echo ""
echo -e "${BOLD}========================================${RESET}"
echo -e "${BOLD}  Steward Fleet Deploy${RESET}"
echo -e "${BOLD}========================================${RESET}"
echo ""

# ---------------------------------------------------------------------------
# Canary: deploy to milady first (with --migrate if requested)
# ---------------------------------------------------------------------------
CANARY="milady"
CANARY_IP="${NODES[$CANARY]}"

echo -e "${CYAN}[fleet]${RESET} ${BOLD}Canary deploy: $CANARY ($CANARY_IP)${RESET}"
echo ""

CANARY_FLAGS=("${EXTRA_FLAGS[@]}")

if "$DEPLOY_SCRIPT" "$CANARY_IP" "${CANARY_FLAGS[@]+"${CANARY_FLAGS[@]}"}"; then
  RESULTS[$CANARY]="OK"
  # Grab version from health
  VERSIONS[$CANARY]=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "root@${CANARY_IP}" \
    "curl -sf http://localhost:3200/health" 2>/dev/null \
    | grep -o '"version":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
  echo ""
  echo -e "${GREEN}[fleet] Canary passed. Rolling out to fleet...${RESET}"
  echo ""
else
  RESULTS[$CANARY]="FAILED"
  VERSIONS[$CANARY]="n/a"
  echo ""
  echo -e "${RED}[fleet] CANARY FAILED. Aborting fleet deploy.${RESET}"
  echo ""
  # Print summary with just canary
  printf "\n${BOLD}%-12s %-10s %-12s${RESET}\n" "NODE" "STATUS" "VERSION"
  printf "%-12s ${RED}%-10s${RESET} %-12s\n" "$CANARY" "FAILED" "n/a"
  exit 1
fi

# ---------------------------------------------------------------------------
# Roll out to remaining nodes (no --migrate, DB is shared)
# ---------------------------------------------------------------------------
# Remove --migrate for agent nodes since DB is shared (already migrated on canary)
AGENT_FLAGS=()
for f in "${EXTRA_FLAGS[@]+"${EXTRA_FLAGS[@]}"}"; do
  [[ "$f" != "--migrate" ]] && AGENT_FLAGS+=("$f")
done

for node in "${NODE_ORDER[@]}"; do
  [[ "$node" == "$CANARY" ]] && continue

  node_ip="${NODES[$node]}"
  echo -e "${CYAN}[fleet]${RESET} Deploying to ${BOLD}$node${RESET} ($node_ip) ..."

  if "$DEPLOY_SCRIPT" "$node_ip" "${AGENT_FLAGS[@]+"${AGENT_FLAGS[@]}"}"; then
    RESULTS[$node]="OK"
    VERSIONS[$node]=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "root@${node_ip}" \
      "curl -sf http://localhost:3200/health" 2>/dev/null \
      | grep -o '"version":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
  else
    RESULTS[$node]="FAILED"
    VERSIONS[$node]="n/a"
  fi
  echo ""
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo -e "${BOLD}========================================${RESET}"
echo -e "${BOLD}  Deploy Summary${RESET}"
echo -e "${BOLD}========================================${RESET}"
echo ""
printf "${BOLD}%-12s %-12s %-12s${RESET}\n" "NODE" "STATUS" "VERSION"
printf "%-12s %-12s %-12s\n" "----" "------" "-------"

TOTAL_OK=0
TOTAL_FAIL=0

for node in "${NODE_ORDER[@]}"; do
  status="${RESULTS[$node]:-SKIPPED}"
  version="${VERSIONS[$node]:-n/a}"

  if [[ "$status" == "OK" ]]; then
    printf "%-12s ${GREEN}%-12s${RESET} %-12s\n" "$node" "$status" "$version"
    TOTAL_OK=$((TOTAL_OK + 1))
  else
    printf "%-12s ${RED}%-12s${RESET} %-12s\n" "$node" "$status" "$version"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
  fi
done

echo ""
echo -e "${BOLD}Total: ${GREEN}$TOTAL_OK OK${RESET}, ${RED}$TOTAL_FAIL FAILED${RESET}"
echo ""

exit $TOTAL_FAIL
