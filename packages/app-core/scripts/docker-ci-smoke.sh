#!/usr/bin/env bash
set -euo pipefail

# Smoke-test the production Docker build path used by .github/workflows/build-docker.yml.
#
# What this does:
#   1. Installs deps with bun using the committed lockfile
#   2. Builds required runtime/UI artifacts for Dockerfile.ci
#   3. Builds the production image locally
#   4. Optionally boots the container and probes /api/health or /api/status
#
# Usage:
#   bash eliza/packages/app-core/scripts/docker-ci-smoke.sh [--tag TAG] [--version VERSION] [--skip-smoke]
#
# Environment:
#   BUN_VERSION          Bun version to install/use in CI (default: 1.3.9)
#   SMOKE_PORT           Host port to bind for smoke boot (default: 32138)
#   SMOKE_TIMEOUT_SEC    Max wait for boot probe (default: 420)
#   DOCKER_IMAGE         Override image tag completely

BUN_VERSION="${BUN_VERSION:-1.3.10}"
SMOKE_PORT="${SMOKE_PORT:-32138}"
CONTAINER_PORT="${CONTAINER_PORT:-42138}"
SMOKE_TIMEOUT_SEC="${SMOKE_TIMEOUT_SEC:-420}"
SKIP_SMOKE=false
TAG="docker-smoke"
VERSION=""

log() {
  printf '[docker-ci-smoke] %s\n' "$*"
}

fail() {
  printf '[docker-ci-smoke] ERROR: %s\n' "$*" >&2
  exit 1
}

find_docker_bin() {
  local candidate
  for candidate in "${DOCKER_BIN:-}" "$(command -v docker 2>/dev/null || true)" \
    /usr/local/bin/docker /opt/homebrew/bin/docker \
    /Applications/Docker.app/Contents/Resources/bin/docker; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

load_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      TAG="$2"
      shift 2
      ;;
    --version)
      VERSION="$2"
      shift 2
      ;;
    --skip-smoke)
      SKIP_SMOKE=true
      shift
      ;;
    -h|--help)
      sed -n '1,24p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

[[ -f package.json ]] || fail "Run from the repo root"
[[ -f eliza/packages/app-core/deploy/Dockerfile.ci ]] || fail "eliza/packages/app-core/deploy/Dockerfile.ci not found"
[[ -f eliza/packages/app-core/deploy/.dockerignore.ci ]] || fail "eliza/packages/app-core/deploy/.dockerignore.ci not found"
[[ -f deploy/deploy.env ]] || fail "deploy/deploy.env not found"

load_env_file "eliza/packages/app-core/deploy/deploy.defaults.env"
load_env_file "deploy/deploy.env"

APP_IMAGE="${APP_IMAGE:-eliza/agent}"
APP_ENTRYPOINT="${APP_ENTRYPOINT:-app.mjs}"
APP_CMD_START="${APP_CMD_START:-node --import ./node_modules/tsx/dist/loader.mjs ${APP_ENTRYPOINT} start}"
APP_PORT="${APP_PORT:-2138}"
APP_API_BIND="${APP_API_BIND:-127.0.0.1}"
OCI_SOURCE="${OCI_SOURCE:-}"
OCI_TITLE="${OCI_TITLE:-elizaOS Agent}"
OCI_DESCRIPTION="${OCI_DESCRIPTION:-elizaOS agent runtime}"
OCI_LICENSES="${OCI_LICENSES:-MIT}"

if [[ -z "$VERSION" ]]; then
  VERSION="v$(node -p "require('./package.json').version")-docker-smoke"
fi
VERSION_CLEAN="${VERSION#v}"
SOURCE_SHA="$(git rev-parse HEAD)"
DOCKER_IMAGE="${DOCKER_IMAGE:-${APP_IMAGE}:${TAG}}"
CONTAINER_NAME="eliza-docker-smoke-${TAG//[^a-zA-Z0-9_.-]/-}"
mkdir -p "$REPO_ROOT/.tmp/qa"
SMOKE_ARTIFACT_DIR="$(mktemp -d "$REPO_ROOT/.tmp/qa/docker-ci-smoke-XXXXXX")"

log "Repo root: $REPO_ROOT"
log "Version: $VERSION"
log "Image: $DOCKER_IMAGE"
log "Smoke port: $SMOKE_PORT"
log "Container port override: $CONTAINER_PORT"
log "Artifact dir: $SMOKE_ARTIFACT_DIR"

command -v node >/dev/null 2>&1 || fail "node is required"
command -v bun >/dev/null 2>&1 || fail "bun is required"

DOCKER_BIN="$(find_docker_bin)" || fail "docker is required"

"$DOCKER_BIN" info >/dev/null 2>&1 || fail "docker daemon is not available"

DOCKERIGNORE_BACKUP="$(mktemp)"
HAD_ROOT_DOCKERIGNORE=0
if [[ -f .dockerignore ]]; then
  HAD_ROOT_DOCKERIGNORE=1
  cp .dockerignore "$DOCKERIGNORE_BACKUP"
else
  : >"$DOCKERIGNORE_BACKUP"
fi
cleanup() {
  set +e
  local containers_file
  containers_file="$(mktemp 2>/dev/null || printf '%s\n' "$SMOKE_ARTIFACT_DIR/docker-containers.txt")"
  timeout 10 "$DOCKER_BIN" ps -a --format '{{.Names}}' >"$containers_file" 2>&1 || true
  if grep -Fxq "$CONTAINER_NAME" "$containers_file" 2>/dev/null; then
    timeout 15 "$DOCKER_BIN" inspect "$CONTAINER_NAME" >"$SMOKE_ARTIFACT_DIR/container-inspect.json" 2>&1 || true
    timeout 30 "$DOCKER_BIN" logs "$CONTAINER_NAME" >"$SMOKE_ARTIFACT_DIR/container.log" 2>&1 || true
    timeout 10 "$DOCKER_BIN" rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
  rm -f "$containers_file" >/dev/null 2>&1 || true
  if [[ -f "$DOCKERIGNORE_BACKUP" ]]; then
    if [[ "$HAD_ROOT_DOCKERIGNORE" == "1" ]]; then
      cp "$DOCKERIGNORE_BACKUP" .dockerignore >/dev/null 2>&1 || true
    else
      rm -f .dockerignore >/dev/null 2>&1 || true
    fi
    rm -f "$DOCKERIGNORE_BACKUP" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

log "Installing dependencies"
node scripts/init-submodules.mjs
MILADY_SKIP_LOCAL_UPSTREAMS=1 ELIZA_SKIP_LOCAL_UPSTREAMS=1 node scripts/disable-local-eliza-workspace.mjs
MILADY_SKIP_LOCAL_UPSTREAMS=1 ELIZA_SKIP_LOCAL_UPSTREAMS=1 bun install --ignore-scripts --no-frozen-lockfile
if [[ -d "$REPO_ROOT/.eliza.ci-disabled" && ! -d "$REPO_ROOT/eliza" ]]; then
  log "Restoring eliza/ from .eliza.ci-disabled for downstream build steps"
  mv "$REPO_ROOT/.eliza.ci-disabled" "$REPO_ROOT/eliza"
fi
export MILADY_SKIP_LOCAL_UPSTREAMS=1
export ELIZA_SKIP_LOCAL_UPSTREAMS=1

log "Installing published-workspace fallback dependencies"
bash "$REPO_ROOT/scripts/install-published-workspace-fallback-deps.sh"

log "Running repository postinstall"
SKIP_AVATAR_CLONE=1 ELIZA_NO_VISION_DEPS=1 node eliza/packages/app-core/scripts/run-repo-setup.mjs

if [[ ! -f eliza/packages/typescript/src/types/generated/eliza/v1/agent_pb.ts ]]; then
  log "Generating core protobuf sources"
  pushd eliza/packages/schemas >/dev/null
  bunx @bufbuild/buf@1.67.0 generate
  popd >/dev/null
fi

log "Building Capacitor plugins"
pushd apps/app >/dev/null
bun scripts/plugin-build.mjs
popd >/dev/null

log "Building agent workspace"
pushd eliza/packages/agent >/dev/null
bun run build:docker-dist
popd >/dev/null

if [[ "${MILADY_SKIP_LOCAL_UPSTREAMS:-0}" == "1" ]]; then
  log "Skipping @elizaos/core source build in published-only mode"
else
  log "Building @elizaos/core and @elizaos/plugin-agent-orchestrator"
  pushd eliza/packages/typescript >/dev/null
  bun run build:node
  popd >/dev/null
fi

log "Building runtime dist"
npx tsdown
echo '{"type":"module"}' > dist/package.json
node --import tsx scripts/write-build-info.ts 2>/dev/null || true

log "Building app UI"
pushd apps/app >/dev/null
NODE_ENV=production npx vite build
popd >/dev/null

log "Preparing CI dockerignore"
cp eliza/packages/app-core/deploy/.dockerignore.ci .dockerignore

log "Re-adding eliza/packages/agent to workspaces for Docker relink"
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (!pkg.workspaces) pkg.workspaces = [];
if (!pkg.workspaces.includes('eliza/packages/agent')) {
  pkg.workspaces.push('eliza/packages/agent');
}
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('Re-added eliza/packages/agent to workspaces');
"

log "Building Docker image"
"$DOCKER_BIN" build \
  --file eliza/packages/app-core/deploy/Dockerfile.ci \
  --tag "$DOCKER_IMAGE" \
  --build-arg "BUN_VERSION=$BUN_VERSION" \
  --build-arg "APP_ENTRYPOINT=$APP_ENTRYPOINT" \
  --build-arg "APP_CMD_START=$APP_CMD_START" \
  --build-arg "APP_PORT=$APP_PORT" \
  --build-arg "APP_API_BIND=$APP_API_BIND" \
  --build-arg "OCI_SOURCE=$OCI_SOURCE" \
  --build-arg "OCI_TITLE=$OCI_TITLE" \
  --build-arg "OCI_DESCRIPTION=$OCI_DESCRIPTION" \
  --build-arg "OCI_LICENSES=$OCI_LICENSES" \
  --build-arg "VERSION=$VERSION" \
  --build-arg "VERSION_CLEAN=$VERSION_CLEAN" \
  --build-arg "REVISION=$SOURCE_SHA" \
  .

if $SKIP_SMOKE; then
  log "Skipping runtime smoke boot (--skip-smoke)"
  exit 0
fi

log "Starting container smoke boot"
"$DOCKER_BIN" rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
"$DOCKER_BIN" run -d \
  --name "$CONTAINER_NAME" \
  -e PORT="$CONTAINER_PORT" \
  -e APP_PORT="$CONTAINER_PORT" \
  -e MILADY_API_PORT="$CONTAINER_PORT" \
  -e ELIZA_API_PORT="$CONTAINER_PORT" \
  -e ELIZA_PORT="$CONTAINER_PORT" \
  -e APP_API_BIND=0.0.0.0 \
  -e MILADY_STATE_DIR=/tmp/milady-smoke/state \
  -e ELIZA_STATE_DIR=/tmp/milady-smoke/state \
  -e MILADY_CONFIG_DIR=/tmp/milady-smoke/config \
  -e ELIZA_CONFIG_DIR=/tmp/milady-smoke/config \
  -e MILADY_WORKSPACE_DIR=/tmp/milady-smoke/workspace \
  -e ELIZA_WORKSPACE_DIR=/tmp/milady-smoke/workspace \
  -e PGLITE_DATA_DIR=/tmp/milady-smoke/pglite \
  -e ELIZA_DISABLE_LOCAL_EMBEDDINGS=1 \
  -e ELIZA_API_BIND=0.0.0.0 \
  -p "${SMOKE_PORT}:${CONTAINER_PORT}" \
  "$DOCKER_IMAGE" >/dev/null

status_url="http://127.0.0.1:${SMOKE_PORT}/api/status"
health_url="http://127.0.0.1:${SMOKE_PORT}/api/health"

probe_ok() {
  local url="$1"
  local out="$2"
  local code
  code="$(curl -sS --connect-timeout 1 --max-time 3 -o "$out" -w '%{http_code}' "$url" || true)"
  case "$code" in
    200)
      return 0
      ;;
    401)
      if grep -q 'Unauthorized' "$out" 2>/dev/null; then
        return 0
      fi
      ;;
  esac
  return 1
}

deadline=$((SECONDS + SMOKE_TIMEOUT_SEC))
last_log_dump=0
while (( SECONDS < deadline )); do
  running_containers_file="$(mktemp 2>/dev/null || printf '%s\n' "$SMOKE_ARTIFACT_DIR/docker-running-containers.txt")"
  timeout 10 "$DOCKER_BIN" ps --format '{{.Names}}' >"$running_containers_file" 2>&1 || true
  if ! grep -Fxq "$CONTAINER_NAME" "$running_containers_file" 2>/dev/null; then
    rm -f "$running_containers_file" >/dev/null 2>&1 || true
    timeout 30 "$DOCKER_BIN" logs "$CONTAINER_NAME" || true
    log "Preserved failure artifacts in $SMOKE_ARTIFACT_DIR"
    fail "Container exited before smoke probe succeeded"
  fi
  rm -f "$running_containers_file" >/dev/null 2>&1 || true

  if (( SECONDS - last_log_dump >= 30 )); then
    last_log_dump=$SECONDS
    log "Container still booting; recent logs follow"
    timeout 10 "$DOCKER_BIN" logs --tail 80 "$CONTAINER_NAME" || true
  fi

  if probe_ok "$health_url" /tmp/milady-docker-health.txt; then
    log "Health probe succeeded: $health_url"
    cat /tmp/milady-docker-health.txt
    exit 0
  fi

  if probe_ok "$status_url" /tmp/milady-docker-status.txt; then
    log "Status probe succeeded: $status_url"
    cat /tmp/milady-docker-status.txt
    exit 0
  fi

  sleep 5
done

timeout 30 "$DOCKER_BIN" logs "$CONTAINER_NAME" || true
log "Preserved timeout artifacts in $SMOKE_ARTIFACT_DIR"
fail "Timed out waiting for container smoke probe (${SMOKE_TIMEOUT_SEC}s)"
