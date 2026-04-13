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
#   scripts/docker-ci-smoke.sh [--tag TAG] [--version VERSION] [--skip-smoke]
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
[[ -f deploy/Dockerfile.ci ]] || fail "deploy/Dockerfile.ci not found"
[[ -f deploy/.dockerignore.ci ]] || fail "deploy/.dockerignore.ci not found"

if [[ -z "$VERSION" ]]; then
  VERSION="v$(node -p "require('./package.json').version")-docker-smoke"
fi
VERSION_CLEAN="${VERSION#v}"
SOURCE_SHA="$(git rev-parse HEAD)"
DOCKER_IMAGE="${DOCKER_IMAGE:-miladyai/agent:${TAG}}"
CONTAINER_NAME="milady-docker-smoke-${TAG//[^a-zA-Z0-9_.-]/-}"
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
  if "$DOCKER_BIN" ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
    "$DOCKER_BIN" inspect "$CONTAINER_NAME" >"$SMOKE_ARTIFACT_DIR/container-inspect.json" 2>&1 || true
    "$DOCKER_BIN" logs "$CONTAINER_NAME" >"$SMOKE_ARTIFACT_DIR/container.log" 2>&1 || true
    "$DOCKER_BIN" rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
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
node scripts/disable-local-eliza-workspace.mjs
bun install --ignore-scripts

log "Running repository postinstall"
SKIP_AVATAR_CLONE=1 MILADY_NO_VISION_DEPS=1 bun run postinstall

log "Building Capacitor plugins"
pushd apps/app >/dev/null
bun scripts/plugin-build.mjs
popd >/dev/null

log "Building shared workspace"
pushd packages/shared >/dev/null
bun run build
popd >/dev/null

log "Building agent workspace"
pushd packages/agent >/dev/null
bun run build:docker-dist
popd >/dev/null

if [[ "${MILADY_SKIP_LOCAL_UPSTREAMS:-0}" != "1" && -d eliza/packages/typescript ]]; then
  log "Building core workspace"
  pushd eliza/packages/typescript >/dev/null
  bun run build
  popd >/dev/null
else
  log "Skipping core workspace build (published upstream mode)"
fi

log "Building @elizaos/core (includes agent-orchestrator)"
pushd eliza/packages/typescript >/dev/null
bun run build
popd >/dev/null

log "Building runtime dist"
npx tsdown
echo '{"type":"module"}' > dist/package.json
node --import tsx scripts/write-build-info.ts 2>/dev/null || true

log "Building app UI"
pushd apps/app >/dev/null
NODE_ENV=production npx vite build
popd >/dev/null

log "Preparing CI dockerignore"
cp deploy/.dockerignore.ci .dockerignore

log "Building Docker image"
"$DOCKER_BIN" build \
  --file deploy/Dockerfile.ci \
  --tag "$DOCKER_IMAGE" \
  --build-arg "BUN_VERSION=$BUN_VERSION" \
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
  -e MILADY_DISABLE_LOCAL_EMBEDDINGS=1 \
  -e MILADY_API_BIND=0.0.0.0 \
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
while (( SECONDS < deadline )); do
  if ! "$DOCKER_BIN" ps --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
    "$DOCKER_BIN" logs "$CONTAINER_NAME" || true
    log "Preserved failure artifacts in $SMOKE_ARTIFACT_DIR"
    fail "Container exited before smoke probe succeeded"
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

"$DOCKER_BIN" logs "$CONTAINER_NAME" || true
log "Preserved timeout artifacts in $SMOKE_ARTIFACT_DIR"
fail "Timed out waiting for container smoke probe (${SMOKE_TIMEOUT_SEC}s)"
