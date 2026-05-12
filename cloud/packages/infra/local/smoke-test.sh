#!/usr/bin/env bash
set -euo pipefail

# Smoke tests for cloud local environment.
# Prereq: ./setup.sh must have been run successfully.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_NAME="srv-smoke"
NAMESPACE="eliza-agents"
PORT=3001

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASSED=0
FAILED=0

pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "${RED}[FAIL]${NC} $1"; FAILED=$((FAILED + 1)); }
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }

PF_PID=""

cleanup() {
  info "Cleaning up..."
  [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null || true
  kubectl delete server "$SERVER_NAME" -n "$NAMESPACE" 2>/dev/null || true
  # Wait for finalizer to clean up
  for i in $(seq 1 15); do
    kubectl get server "$SERVER_NAME" -n "$NAMESPACE" > /dev/null 2>&1 || break
    sleep 2
  done
}
trap cleanup EXIT

# ============================================================================
# 1. Precondition checks
# ============================================================================

info "Checking preconditions..."
kubectl cluster-info --context kind-eliza-local > /dev/null 2>&1 || { fail "Cluster not reachable"; exit 1; }
kubectl get crd servers.eliza.ai > /dev/null 2>&1 || { fail "Server CRD not installed"; exit 1; }
OPERATOR_UP=""
for i in $(seq 1 10); do
  kubectl get pods -n pepr-system --no-headers 2>/dev/null | grep -q "Running" && { OPERATOR_UP="yes"; break; }
  sleep 3
done
[ -n "$OPERATOR_UP" ] || { fail "Operator not running"; exit 1; }
pass "Preconditions OK"

# ============================================================================
# 2. Create Server CR
# ============================================================================

info "Creating Server CR '$SERVER_NAME'..."
cat <<EOF | kubectl apply -f -
apiVersion: eliza.ai/v1alpha1
kind: Server
metadata:
  name: ${SERVER_NAME}
  namespace: ${NAMESPACE}
spec:
  capacity: 5
  tier: shared
  project: cloud
  image: localhost:5001/agent-server:dev
  secretRef: eliza-agent-secrets
  resources:
    requests:
      memory: "256Mi"
      cpu: "100m"
    limits:
      memory: "1Gi"
      cpu: "500m"
EOF

sleep 3
kubectl get deployment "$SERVER_NAME" -n "$NAMESPACE" > /dev/null 2>&1 && pass "Deployment created" || fail "Deployment not created"
kubectl get service "$SERVER_NAME" -n "$NAMESPACE" > /dev/null 2>&1 && pass "Service created" || fail "Service not created"
kubectl get scaledobject "$SERVER_NAME" -n "$NAMESPACE" > /dev/null 2>&1 && pass "ScaledObject created" || fail "ScaledObject not created"

# ============================================================================
# 3. Wake up via KEDA (push activity to Redis)
# ============================================================================

info "Waking pod via KEDA..."
kubectl run smoke-wake --rm -i --restart=Never -n eliza-infra \
  --image=redis:7-alpine --quiet -- \
  redis-cli -h redis LPUSH "keda:${SERVER_NAME}:activity" "wake" > /dev/null 2>&1

info "Waiting for pod to be Ready..."
POD_READY=""
for i in $(seq 1 60); do
  POD_LINE=$(kubectl get pods -n "$NAMESPACE" -l "eliza.ai/server=${SERVER_NAME}" --no-headers 2>/dev/null || true)
  if echo "$POD_LINE" | grep -q "1/1.*Running"; then
    POD_READY="yes"
    break
  fi
  sleep 5
done

if [ -n "$POD_READY" ]; then
  pass "Pod is Ready"
else
  fail "Pod did not become ready within 300s"
  kubectl logs -n "$NAMESPACE" -l "eliza.ai/server=${SERVER_NAME}" --tail=20 2>/dev/null || true
  exit 1
fi

# --- CR phase transition ---
info "Checking Server CR phase..."
sleep 3  # Allow watcher to propagate
CR_PHASE=$(kubectl get server "$SERVER_NAME" -n "$NAMESPACE" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
[ "$CR_PHASE" = "Running" ] && pass "Server CR phase is Running" || fail "Server CR phase — expected Running, got: $CR_PHASE"

# ============================================================================
# 4. Port-forward
# ============================================================================

kubectl port-forward -n "$NAMESPACE" "svc/${SERVER_NAME}" "${PORT}:3000" > /dev/null 2>&1 &
PF_PID=$!
sleep 5

# ============================================================================
# 5. Test endpoints
# ============================================================================

BASE="http://localhost:${PORT}"

# --- Health ---
info "Testing GET /health..."
RESP=$(curl -sf "${BASE}/health" 2>/dev/null || echo "CURL_FAIL")
echo "$RESP" | grep -q '"alive":true' && pass "GET /health" || fail "GET /health — got: $RESP"

# --- Ready ---
info "Testing GET /ready..."
RESP=$(curl -sf "${BASE}/ready" 2>/dev/null || echo "CURL_FAIL")
echo "$RESP" | grep -q '"ready":true' && pass "GET /ready" || fail "GET /ready — got: $RESP"

# --- Status (empty) ---
info "Testing GET /status..."
RESP=$(curl -sf "${BASE}/status" 2>/dev/null || echo "CURL_FAIL")
echo "$RESP" | grep -q "\"serverName\":\"${SERVER_NAME}\"" && pass "GET /status (serverName)" || fail "GET /status — got: $RESP"
echo "$RESP" | grep -q '"agentCount":0' && pass "GET /status (0 agents)" || fail "GET /status agents — got: $RESP"

# --- Create agent ---
info "Testing POST /agents..."
RESP=$(curl -sf -X POST "${BASE}/agents" \
  -H "Content-Type: application/json" \
  -d '{"agentId":"smoke-agent","characterRef":"Eliza"}' 2>/dev/null || echo "CURL_FAIL")
echo "$RESP" | grep -q '"status":"running"' && pass "POST /agents (create)" || fail "POST /agents — got: $RESP"

# --- Status (1 agent) ---
RESP=$(curl -sf "${BASE}/status" 2>/dev/null || echo "CURL_FAIL")
echo "$RESP" | grep -q '"agentCount":1' && pass "GET /status (1 agent)" || fail "GET /status after create — got: $RESP"

# --- Send message ---
info "Testing POST /agents/:id/message..."
RESP=$(curl -sf -X POST "${BASE}/agents/smoke-agent/message" \
  -H "Content-Type: application/json" \
  -d '{"userId":"smoke-user","text":"hello"}' 2>/dev/null || echo "CURL_FAIL")
echo "$RESP" | grep -q '"response"' && pass "POST /agents/:id/message" || fail "POST /agents/:id/message — got: $RESP"

# --- Stop agent ---
info "Testing POST /agents/:id/stop..."
RESP=$(curl -sf -X POST "${BASE}/agents/smoke-agent/stop" 2>/dev/null || echo "CURL_FAIL")
echo "$RESP" | grep -q '"status":"stopped"' && pass "POST /agents/:id/stop" || fail "POST /agents/:id/stop — got: $RESP"

# --- Delete agent ---
info "Testing DELETE /agents/:id..."
RESP=$(curl -sf -X DELETE "${BASE}/agents/smoke-agent" 2>/dev/null || echo "CURL_FAIL")
echo "$RESP" | grep -q '"deleted":true' && pass "DELETE /agents/:id" || fail "DELETE /agents/:id — got: $RESP"

# --- Status (0 agents after delete) ---
RESP=$(curl -sf "${BASE}/status" 2>/dev/null || echo "CURL_FAIL")
echo "$RESP" | grep -q '"agentCount":0' && pass "GET /status (0 agents after delete)" || fail "GET /status after delete — got: $RESP"

# --- 404 on unknown agent ---
info "Testing 404 responses..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE}/agents/nonexistent/message" \
  -H "Content-Type: application/json" \
  -d '{"userId":"u","text":"t"}' 2>/dev/null)
[ "$HTTP_CODE" = "404" ] && pass "404 on unknown agent" || fail "Expected 404, got $HTTP_CODE"

# ============================================================================
# 6. Verify Redis keys
# ============================================================================

info "Checking Redis keys..."
REDIS_KEYS=$(kubectl run smoke-redis --rm -i --restart=Never -n eliza-infra \
  --image=redis:7-alpine --quiet -- \
  redis-cli -h redis GET "server:${SERVER_NAME}:status" 2>/dev/null || echo "")
echo "$REDIS_KEYS" | grep -q "running" && pass "Redis server status key" || fail "Redis server status key — got: $REDIS_KEYS"

# ============================================================================
# 7. Summary
# ============================================================================

echo ""
echo "======================================="
echo -e "  ${GREEN}PASSED: ${PASSED}${NC}  ${RED}FAILED: ${FAILED}${NC}"
echo "======================================="

[ "$FAILED" -eq 0 ] && echo -e "${GREEN}All smoke tests passed.${NC}" || echo -e "${RED}Some tests failed.${NC}"
exit "$FAILED"
