#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLOUD_V2_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CLUSTER_NAME="eliza-local"
REGISTRY_NAME="kind-registry"
REGISTRY_PORT="5001"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }

require_cmd() {
  local label="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    pass "$label"
  else
    fail "$label"
  fi
}

# 1. Check Docker
info "Checking Docker..."
docker info > /dev/null 2>&1 || fail "Docker is not running"
pass "Docker is running"

# Note: the cloud app (apps/api + apps/frontend) uses embedded PGlite + Wadis
# for local dev — no docker-compose Postgres or Redis required. This script
# bootstraps the kind cluster + CNPG Postgres + Bitnami Redis used by the
# in-cluster agent-server and gateway services.

# 2. Create local registry (if not exists)
info "Creating local registry..."
if docker inspect "$REGISTRY_NAME" > /dev/null 2>&1; then
  info "  Registry already exists"
else
  docker run -d --restart=always -p "${REGISTRY_PORT}:5000" --network bridge --name "$REGISTRY_NAME" registry:2
fi
pass "Local registry on localhost:${REGISTRY_PORT}"

# 4. Create kind cluster (if not exists)
info "Creating kind cluster '$CLUSTER_NAME'..."
if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
  info "  Cluster already exists"
else
  kind create cluster --config "$SCRIPT_DIR/kind-config.yaml" --name "$CLUSTER_NAME"
fi

# 5. Export kubeconfig
info "Exporting kubeconfig..."
kind export kubeconfig --name "$CLUSTER_NAME"
pass "kubeconfig exported for kind-${CLUSTER_NAME}"

# 6. Connect registry to kind network
docker network connect kind "$REGISTRY_NAME" 2>/dev/null || true

# 7. Configure registry on cluster nodes (containerd 2.x hosts dir)
info "Configuring registry on cluster nodes..."
REGISTRY_DIR="/etc/containerd/certs.d/localhost:${REGISTRY_PORT}"
for node in $(kind get nodes --name "$CLUSTER_NAME"); do
  docker exec "$node" mkdir -p "$REGISTRY_DIR"
  cat <<TOML | docker exec -i "$node" cp /dev/stdin "$REGISTRY_DIR/hosts.toml"
[host."http://${REGISTRY_NAME}:5000"]
TOML
done
pass "Registry configured on all nodes"

# 8. Set kubectl context
kubectl cluster-info --context "kind-${CLUSTER_NAME}" > /dev/null 2>&1 || fail "Cannot connect to cluster"
pass "kubectl connected to kind-${CLUSTER_NAME}"

# 9. Create namespaces
info "Creating namespaces..."
kubectl apply -f "$SCRIPT_DIR/manifests/namespaces.yaml"
pass "Namespaces created"

# 10. Create ExternalName services (redis alias, eliza-cloud → host.docker.internal)
info "Creating ExternalName services..."
kubectl apply -f "$SCRIPT_DIR/manifests/external-services.yaml"
pass "ExternalName services created"

# 11. Install KEDA
info "Installing KEDA..."
helm repo add kedacore https://kedacore.github.io/charts 2>/dev/null || true
helm repo update kedacore > /dev/null 2>&1

if helm status keda -n keda > /dev/null 2>&1; then
  info "  KEDA already installed"
else
  helm install keda kedacore/keda --namespace keda --create-namespace --wait --timeout 120s
fi
pass "KEDA installed"

# 12. Install metrics-server (required for KEDA CPU trigger)
info "Installing metrics-server..."
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/ 2>/dev/null || true
helm repo update metrics-server > /dev/null 2>&1

if helm status metrics-server -n kube-system > /dev/null 2>&1; then
  info "  metrics-server already installed"
else
  helm install metrics-server metrics-server/metrics-server \
    --namespace kube-system \
    --set args[0]=--kubelet-insecure-tls \
    --wait --timeout 60s
fi
pass "metrics-server installed"

# 12b. Install CloudNativePG operator (Helm)
info "Installing CloudNativePG operator..."
helm repo add cnpg https://cloudnative-pg.github.io/charts 2>/dev/null || true
helm repo update cnpg > /dev/null 2>&1

if helm status cnpg -n cnpg-system > /dev/null 2>&1; then
  info "  CNPG operator already installed"
else
  helm install cnpg cnpg/cloudnative-pg --namespace cnpg-system --create-namespace --wait --timeout 120s
fi
pass "CloudNativePG operator installed"

# 12c. Deploy local PostgreSQL cluster (CNPG Helm chart)
info "Deploying local PostgreSQL cluster via CNPG..."
helm upgrade --install pg-local cnpg/cluster \
  --namespace eliza-agents \
  --values "$SCRIPT_DIR/values-pg-local.yaml" \
  --wait --timeout 180s
pass "CNPG PostgreSQL cluster deployed"

# Wait for CNPG operator to fully provision the cluster (creates secrets, pooler, etc.)
info "Waiting for CNPG cluster to be ready..."
for i in $(seq 1 60); do
  if kubectl get secret pg-local-cluster-app -n eliza-agents > /dev/null 2>&1; then
    break
  fi
  [ "$i" -eq 60 ] && fail "CNPG cluster secret pg-local-cluster-app not created after 120s"
  sleep 2
done
kubectl wait --for=condition=Ready cluster/pg-local-cluster -n eliza-agents --timeout=120s 2>/dev/null || true
pass "CNPG cluster ready (secret pg-local-cluster-app exists)"

# 12d. Install Redis (Bitnami Helm)
info "Installing Redis..."
helm repo add bitnami https://charts.bitnami.com/bitnami 2>/dev/null || true
helm repo update bitnami > /dev/null 2>&1

helm upgrade --install redis bitnami/redis \
  --namespace eliza-infra \
  --values "$SCRIPT_DIR/values-redis-local.yaml" \
  --wait --timeout 120s
pass "Redis installed (Bitnami Helm)"

# 12e. Deploy redis-rest proxy (Upstash-compatible HTTP proxy for gateways)
info "Deploying redis-rest proxy..."
kubectl apply -f "$SCRIPT_DIR/manifests/redis-rest.yaml"
kubectl rollout status deployment/redis-rest -n eliza-infra --timeout=60s
pass "redis-rest proxy deployed"

# 13. Create K8s Secret for agent-server env
info "Creating eliza-agent-secrets Secret..."

# Extract CNPG-generated DATABASE_URL from the cluster secret
CNPG_DB_URI=$(kubectl get secret pg-local-cluster-app -n eliza-agents -o jsonpath='{.data.uri}' | base64 -d)
info "  CNPG DATABASE_URL: $CNPG_DB_URI"

ENV_FILE="$SCRIPT_DIR/.env.agents"
if [ ! -f "$ENV_FILE" ]; then
  info "  No .env.agents found, creating with defaults..."
  cat > "$ENV_FILE" <<DEFAULTS
DATABASE_URL=${CNPG_DB_URI}
REDIS_URL=redis://redis.eliza-infra.svc:6379
ENABLE_DATA_ISOLATION=true
ELIZA_SERVER_ID=agent-server-local
AGENT_SERVER_SHARED_SECRET=local-dev-agent-server-secret
# Uncomment and set to enable LLM via ElizaCloud proxy:
# ELIZAOS_CLOUD_API_KEY=ek_xxx
# ELIZAOS_CLOUD_BASE_URL=https://www.elizacloud.ai/api/v1
DEFAULTS
  info "  Edit $ENV_FILE to add your API keys, then re-run setup."
else
  # Update DATABASE_URL in existing .env.agents to use CNPG
  if grep -q "^DATABASE_URL=" "$ENV_FILE"; then
    sed -i.bak "s|^DATABASE_URL=.*|DATABASE_URL=${CNPG_DB_URI}|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
    info "  Updated DATABASE_URL in existing .env.agents"
  fi
fi
kubectl create secret generic eliza-agent-secrets \
  --namespace eliza-agents \
  --from-env-file="$ENV_FILE" \
  --dry-run=client -o yaml | kubectl apply -f -
pass "Secret eliza-agent-secrets created from .env.agents"

# 14. Build & deploy operator
info "Building operator..."
cd "$CLOUD_V2_DIR/services/operator"
npm install --silent 2>/dev/null
npx pepr build 2>&1 | tail -1

# Inject CRD into the generated Helm chart (Helm applies crds/ before templates)
mkdir -p dist/eliza-operator-chart/crds
cp crds/server-crd.yaml dist/eliza-operator-chart/crds/
cd "$SCRIPT_DIR"

info "Deploying operator via Helm..."
# Pre-create and annotate namespace so Helm can adopt it (chart template includes namespace.yaml)
kubectl create namespace pepr-system 2>/dev/null || true
kubectl label namespace pepr-system app.kubernetes.io/managed-by=Helm --overwrite > /dev/null 2>&1
kubectl annotate namespace pepr-system meta.helm.sh/release-name=eliza-operator --overwrite > /dev/null 2>&1
kubectl annotate namespace pepr-system meta.helm.sh/release-namespace=pepr-system --overwrite > /dev/null 2>&1
helm upgrade --install eliza-operator \
  "$CLOUD_V2_DIR/services/operator/dist/eliza-operator-chart/" \
  --namespace pepr-system --wait --timeout 120s

kubectl rollout status deployment/pepr-eliza-operator-watcher -n pepr-system --timeout=60s > /dev/null 2>&1
pass "Operator deployed"

# 15. Build & push agent-server image
info "Building agent-server image..."
cd "$CLOUD_V2_DIR/services/agent-server"
bun install --silent 2>/dev/null || npm install --silent 2>/dev/null
cd "$SCRIPT_DIR"

docker build -t "localhost:${REGISTRY_PORT}/agent-server:dev" \
  "$CLOUD_V2_DIR/services/agent-server"
docker push "localhost:${REGISTRY_PORT}/agent-server:dev"
pass "Agent-server image pushed to localhost:${REGISTRY_PORT}"

# 16. Build & push gateway-discord image
info "Building gateway-discord image..."
cd "$CLOUD_V2_DIR/services/gateway-discord"
bun install --silent 2>/dev/null || npm install --silent 2>/dev/null
cd "$SCRIPT_DIR"

docker build -t "localhost:${REGISTRY_PORT}/gateway-discord:dev" \
  "$CLOUD_V2_DIR/services/gateway-discord"
docker push "localhost:${REGISTRY_PORT}/gateway-discord:dev"
pass "Gateway-discord image pushed to localhost:${REGISTRY_PORT}"

# 17. Create gateway-discord Secret
info "Creating gateway-discord-secrets Secret..."
GW_ENV_FILE="$SCRIPT_DIR/.env.gateway"
if [ ! -f "$GW_ENV_FILE" ]; then
  info "  No .env.gateway found, creating with defaults..."
  cat > "$GW_ENV_FILE" <<'DEFAULTS'
ELIZA_CLOUD_URL=http://eliza-cloud.eliza-infra.svc:3000
KV_REST_API_URL=http://redis-rest.eliza-infra.svc:8079
KV_REST_API_TOKEN=local_dev_token
GATEWAY_BOOTSTRAP_SECRET=local-dev-gateway-secret-change-me
VOICE_MESSAGE_ENABLED=false
LOG_LEVEL=debug
# Eliza App bot (optional — set to test the system-wide bot)
# ELIZA_APP_DISCORD_BOT_TOKEN=your-bot-token
# ELIZA_APP_DISCORD_APPLICATION_ID=your-application-id
KEDA_COOLDOWN_SECONDS=60
DEFAULTS
  info "  Edit $GW_ENV_FILE with your secrets, then re-run setup."
fi
kubectl create secret generic gateway-discord-secrets \
  --namespace eliza-infra \
  --from-env-file="$GW_ENV_FILE" \
  --dry-run=client -o yaml | kubectl apply -f -
pass "Secret gateway-discord-secrets created from .env.gateway"

# 18. Deploy gateway-discord via Helm chart
info "Deploying gateway-discord via Helm..."
helm upgrade --install gateway-discord \
  "$CLOUD_V2_DIR/services/gateway-discord/chart" \
  --namespace eliza-infra \
  --values "$SCRIPT_DIR/values-gateway.yaml" \
  --wait --timeout 120s
pass "Gateway-discord deployed via Helm"

# 19. Build & push gateway-webhook image
info "Building gateway-webhook image..."
cd "$CLOUD_V2_DIR/services/gateway-webhook"
bun install --silent 2>/dev/null || npm install --silent 2>/dev/null
cd "$SCRIPT_DIR"

docker build -t "localhost:${REGISTRY_PORT}/gateway-webhook:dev" \
  "$CLOUD_V2_DIR/services/gateway-webhook"
docker push "localhost:${REGISTRY_PORT}/gateway-webhook:dev"
pass "Gateway-webhook image pushed to localhost:${REGISTRY_PORT}"

# 20. Create gateway-webhook Secret
info "Creating gateway-webhook-secrets Secret..."
GW_WEBHOOK_ENV_FILE="$SCRIPT_DIR/.env.gateway-webhook"
if [ ! -f "$GW_WEBHOOK_ENV_FILE" ]; then
  info "  No .env.gateway-webhook found, creating with defaults..."
  cat > "$GW_WEBHOOK_ENV_FILE" <<'DEFAULTS'
GATEWAY_BOOTSTRAP_SECRET=local-dev-gateway-secret-change-me
KV_REST_API_URL=http://redis-rest.eliza-infra.svc:8079
KV_REST_API_TOKEN=local_dev_token
ELIZA_CLOUD_URL=http://eliza-cloud.eliza-infra.svc:3000
ELIZA_APP_TELEGRAM_BOT_TOKEN=
ELIZA_APP_TELEGRAM_WEBHOOK_SECRET=
ELIZA_APP_BLOOIO_API_KEY=
ELIZA_APP_BLOOIO_WEBHOOK_SECRET=
ELIZA_APP_BLOOIO_PHONE_NUMBER=
ELIZA_APP_TWILIO_ACCOUNT_SID=
ELIZA_APP_TWILIO_AUTH_TOKEN=
ELIZA_APP_TWILIO_PHONE_NUMBER=
ELIZA_APP_WHATSAPP_ACCESS_TOKEN=
ELIZA_APP_WHATSAPP_PHONE_NUMBER_ID=
ELIZA_APP_WHATSAPP_APP_SECRET=
ELIZA_APP_WHATSAPP_VERIFY_TOKEN=
ELIZA_APP_WHATSAPP_PHONE_NUMBER=
ELIZA_APP_DEFAULT_AGENT_ID=b850bc30-45f8-0041-a00a-83df46d8555d
DEFAULTS
  info "  Edit $GW_WEBHOOK_ENV_FILE with your secrets, then re-run setup."
fi
kubectl create secret generic gateway-webhook-secrets \
  --namespace eliza-infra \
  --from-env-file="$GW_WEBHOOK_ENV_FILE" \
  --dry-run=client -o yaml | kubectl apply -f -
pass "Secret gateway-webhook-secrets created from .env.gateway-webhook"

# 21. Deploy gateway-webhook via Helm chart
info "Deploying gateway-webhook via Helm..."
helm upgrade --install gateway-webhook \
  "$CLOUD_V2_DIR/packages/infra/charts/gateway-webhook" \
  --namespace eliza-infra \
  --values "$SCRIPT_DIR/values-gateway-webhook.yaml" \
  --wait --timeout 120s
pass "Gateway-webhook deployed via Helm"

# 22. Apply Server CRs
info "Applying Server CRs..."
for cr in "$SCRIPT_DIR"/manifests/shared-*.yaml; do
  [ -f "$cr" ] && kubectl apply -f "$cr" && info "  Applied $(basename "$cr")"
done
pass "Server CRs applied"

# === Verification ===
echo ""
info "=== Verification ==="

# Check namespaces
require_cmd "Namespace eliza-agents" kubectl get ns eliza-agents
require_cmd "Namespace eliza-infra" kubectl get ns eliza-infra

# Check KEDA pods
KEDA_READY=$(kubectl get pods -n keda --no-headers 2>/dev/null | grep -c "Running" || true)
if [ "$KEDA_READY" -ge 1 ]; then
  pass "KEDA pods running ($KEDA_READY)"
else
  fail "KEDA pods not ready"
fi

# Check KEDA CRDs
require_cmd "KEDA CRD: ScaledObject" kubectl get crd scaledobjects.keda.sh

# Check CNPG operator
CNPG_READY=$(kubectl get pods -n cnpg-system --no-headers 2>/dev/null | grep -c "Running" || true)
if [ "$CNPG_READY" -ge 1 ]; then
  pass "CNPG operator running ($CNPG_READY)"
else
  fail "CNPG operator not ready"
fi

# Check CNPG cluster
require_cmd "CNPG cluster: pg-local-cluster" kubectl get cluster pg-local-cluster -n eliza-agents

# Check Redis (Bitnami in-cluster)
REDIS_READY=$(kubectl get pods -n eliza-infra -l app.kubernetes.io/name=redis --no-headers 2>/dev/null | grep -c "Running" || true)
if [ "$REDIS_READY" -ge 1 ]; then
  pass "Redis pods running ($REDIS_READY)"
else
  fail "Redis pods not ready"
fi

# Check redis-rest proxy
REDIS_REST_READY=$(kubectl get pods -n eliza-infra -l app=redis-rest --no-headers 2>/dev/null | grep -c "Running" || true)
if [ "$REDIS_REST_READY" -ge 1 ]; then
  pass "redis-rest proxy running ($REDIS_REST_READY)"
else
  fail "redis-rest proxy not ready"
fi

# Check services
require_cmd "Service: redis.eliza-infra (alias)" kubectl get svc redis -n eliza-infra
require_cmd "Service: redis-rest.eliza-infra" kubectl get svc redis-rest -n eliza-infra
require_cmd "Service: eliza-cloud.eliza-infra" kubectl get svc eliza-cloud -n eliza-infra

# Check operator
require_cmd "CRD: servers.eliza.ai" kubectl get crd servers.eliza.ai
OPERATOR_READY=$(kubectl get pods -n pepr-system --no-headers 2>/dev/null | grep -c "Running" || true)
if [ "$OPERATOR_READY" -ge 2 ]; then
  pass "Operator pods running ($OPERATOR_READY)"
else
  fail "Operator pods not ready"
fi

# Check CNPG PostgreSQL connectivity via pooler
info "Testing CNPG PostgreSQL connectivity from cluster..."
CNPG_TEST_URI=$(kubectl get secret pg-local-cluster-app -n eliza-agents -o jsonpath='{.data.uri}' | base64 -d)
if kubectl run pg-test --rm -i --restart=Never -n eliza-agents \
  --image=postgres:17-alpine --quiet -- \
  psql "$CNPG_TEST_URI" \
  -t -c "SELECT 'pg-ok'" 2>/dev/null | grep -q "pg-ok"; then
  pass "CNPG PostgreSQL reachable from cluster"
else
  fail "CNPG PostgreSQL NOT reachable from cluster"
fi

# Check Redis connectivity from inside the cluster
info "Testing Redis connectivity from cluster..."
if kubectl run redis-test --rm -i --restart=Never -n eliza-infra \
  --image=redis:7-alpine --quiet -- \
  redis-cli -h redis PING 2>/dev/null | grep -q "PONG"; then
  pass "Redis reachable from cluster"
else
  fail "Redis NOT reachable from cluster"
fi

echo ""
echo -e "${GREEN}=== All checks passed ===${NC}"
echo ""
echo "Cluster:      kind-${CLUSTER_NAME}"
echo "Registry:     localhost:${REGISTRY_PORT}"
echo "PostgreSQL:   CNPG pg-local-cluster in eliza-agents (secret: pg-local-cluster-app)"
echo "Redis:        Bitnami in-cluster (alias: redis.eliza-infra.svc:6379)"
echo "Redis REST:   redis-rest.eliza-infra.svc:8079 (token: local_dev_token)"
echo "Eliza Cloud:  eliza-cloud.eliza-infra.svc:3000 (run Next.js on host)"
echo "KEDA:         installed in namespace 'keda'"
echo ""
echo "Operator:     deployed in namespace 'pepr-system'"
echo "Agent img:    localhost:${REGISTRY_PORT}/agent-server:dev"
echo "Gateway img:  localhost:${REGISTRY_PORT}/gateway-discord:dev"
echo "Webhook img:  localhost:${REGISTRY_PORT}/gateway-webhook:dev"
echo ""
echo "Next steps:"
echo "  1. Start Eliza Cloud locally:  cd cloud && bun dev"
echo "  2. Check gateway logs:         kubectl logs -f -n eliza-infra -l app=gateway-discord"
echo "  3. Check webhook gateway logs: kubectl logs -f -n eliza-infra -l app=gateway-webhook"
echo "  4. Send a DM to the Eliza App bot on Discord"
