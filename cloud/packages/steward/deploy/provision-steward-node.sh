#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# provision-steward-node.sh — Deploy Steward on a Eliza node
#
# Idempotent: safe to re-run. Will rebuild image and restart service.
#
# Usage:
#   ./deploy/provision-steward-node.sh <node-ip> [ssh-key]
#
# Environment variables (required):
#   STEWARD_MASTER_PASSWORD  — Vault master encryption password
#
# Optional env vars:
#   DATABASE_URL             — External DB (default: local Postgres via compose)
#   RPC_URL                  — EVM RPC endpoint (default: Base mainnet)
#   CHAIN_ID                 — EVM chain ID (default: 8453)
#   SOLANA_RPC_URL           — Solana RPC endpoint
#   STEWARD_REPO             — Git repo URL (default: current directory rsync)
#   SSH_KEY                  — Path to SSH key (default: ~/.ssh/id_ed25519)
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Args ─────────────────────────────────────────────────────────────────────
NODE_IP="${1:?Usage: $0 <node-ip> [ssh-key]}"
SSH_KEY="${2:-${SSH_KEY:-$HOME/.ssh/id_ed25519}}"

# ── Validation ───────────────────────────────────────────────────────────────
if [[ -z "${STEWARD_MASTER_PASSWORD:-}" ]]; then
  echo "❌ STEWARD_MASTER_PASSWORD is required"
  exit 1
fi

SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ${SSH_KEY}"
SSH_CMD="ssh ${SSH_OPTS} root@${NODE_IP}"
SCP_CMD="scp ${SSH_OPTS}"
REMOTE_DIR="/opt/steward"

echo "══════════════════════════════════════════════════════════════"
echo "  Steward Node Provisioning"
echo "  Node: ${NODE_IP}"
echo "══════════════════════════════════════════════════════════════"

# ── Step 1: Ensure eliza-isolated network exists ────────────────────────────
echo ""
echo "▸ Step 1: Checking Docker network..."
${SSH_CMD} "docker network inspect eliza-isolated >/dev/null 2>&1 || docker network create eliza-isolated"
echo "  ✓ eliza-isolated network ready"

# ── Step 2: Sync source code to node ────────────────────────────────────────
echo ""
echo "▸ Step 2: Syncing Steward source to ${NODE_IP}:${REMOTE_DIR}..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# rsync source (excluding heavy dirs)
rsync -az --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='web' \
  --exclude='.turbo' \
  -e "ssh ${SSH_OPTS}" \
  "${REPO_ROOT}/" "root@${NODE_IP}:${REMOTE_DIR}/"
echo "  ✓ Source synced"

# ── Step 3: Write .env file on node ─────────────────────────────────────────
echo ""
echo "▸ Step 3: Writing environment config..."
${SSH_CMD} "cat > ${REMOTE_DIR}/deploy/.env << 'ENVEOF'
STEWARD_MASTER_PASSWORD=${STEWARD_MASTER_PASSWORD}
DATABASE_URL=${DATABASE_URL:-}
RPC_URL=${RPC_URL:-https://mainnet.base.org}
CHAIN_ID=${CHAIN_ID:-8453}
SOLANA_RPC_URL=${SOLANA_RPC_URL:-https://api.mainnet-beta.solana.com}
ENVEOF
chmod 600 ${REMOTE_DIR}/deploy/.env"
echo "  ✓ Environment configured"

# ── Step 4: Build and start services ────────────────────────────────────────
echo ""
echo "▸ Step 4: Building Steward Docker image..."
${SSH_CMD} "cd ${REMOTE_DIR} && docker compose -f deploy/docker-compose.yml build --no-cache steward"
echo "  ✓ Image built"

echo ""
echo "▸ Step 5: Starting services..."
${SSH_CMD} "cd ${REMOTE_DIR} && docker compose -f deploy/docker-compose.yml up -d"
echo "  ✓ Services started"

# ── Step 6: Wait for healthy ─────────────────────────────────────────────────
echo ""
echo "▸ Step 6: Waiting for Steward to become healthy..."
for i in $(seq 1 30); do
  if ${SSH_CMD} "curl -sf http://localhost:3200/health" >/dev/null 2>&1; then
    echo "  ✓ Steward is healthy!"
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo "  ❌ Steward failed to start within 60s"
    echo "  Check logs: ssh root@${NODE_IP} docker compose -f ${REMOTE_DIR}/deploy/docker-compose.yml logs steward"
    exit 1
  fi
  sleep 2
done

# ── Step 7: Create eliza-cloud tenant (idempotent) ─────────────────────────
echo ""
echo "▸ Step 7: Creating eliza-cloud tenant..."

# Read the platform key from the running container
PLATFORM_KEY=$(${SSH_CMD} "docker exec steward printenv STEWARD_PLATFORM_KEY 2>/dev/null || echo ''")

if [[ -z "${PLATFORM_KEY}" ]]; then
  echo "  ⚠  No STEWARD_PLATFORM_KEY set — generating one..."
  PLATFORM_KEY=$(openssl rand -hex 32)
  # Update .env and restart
  ${SSH_CMD} "echo 'STEWARD_PLATFORM_KEY=${PLATFORM_KEY}' >> ${REMOTE_DIR}/deploy/.env"
  ${SSH_CMD} "cd ${REMOTE_DIR} && docker compose -f deploy/docker-compose.yml up -d steward"
  sleep 5
fi

# Create tenant (ignore 409 conflict = already exists)
TENANT_RESP=$(${SSH_CMD} "curl -sf -X POST http://localhost:3200/platform/tenants \
  -H 'Content-Type: application/json' \
  -H 'X-Steward-Platform-Key: ${PLATFORM_KEY}' \
  -d '{\"id\": \"eliza-cloud\", \"name\": \"Eliza Cloud\"}'" 2>&1 || true)

if echo "${TENANT_RESP}" | grep -q '"ok":true'; then
  echo "  ✓ Tenant eliza-cloud created"
elif echo "${TENANT_RESP}" | grep -qi 'already exists\|conflict\|duplicate'; then
  echo "  ✓ Tenant eliza-cloud already exists"
else
  echo "  ⚠  Tenant creation response: ${TENANT_RESP}"
fi

# ── Output ───────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  ✅ Steward deployed successfully!"
echo ""
echo "  Steward URL:    http://${NODE_IP}:3200"
echo "  Health check:   http://${NODE_IP}:3200/health"
echo "  Platform Key:   ${PLATFORM_KEY}"
echo ""
echo "  Agent config (add to container env):"
echo "    STEWARD_API_URL=http://steward:3200"
echo "    (agents on eliza-isolated network reach Steward by container name)"
echo ""
echo "  External access:"
echo "    STEWARD_API_URL=http://${NODE_IP}:3200"
echo "══════════════════════════════════════════════════════════════"
