#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-image.sh — Reproducible build pipeline for eliza/agent Docker image
#
# Usage:
#   bash eliza/packages/app-core/scripts/build-image.sh [OPTIONS]
#
# Options:
#   --version VER    Override version string (default: read from package.json)
#   --tag TAG        Docker image tag (default: v{version})
#   --remote         Build on eliza-core-1 (${BUILD_SERVER:-"root@your-server"}) instead of locally
#   --push           After local build, push/load image to eliza-core-1
#   --no-install     Skip bun install (if deps are already up to date)
#   --no-tsdown      Skip tsdown build (if dist/ is already built)
#   --dry-run        Show what would be done without executing
#   -h, --help       Show this help
#
# Examples:
#   bash eliza/packages/app-core/scripts/build-image.sh                             # Build alpha.89 locally
#   bash eliza/packages/app-core/scripts/build-image.sh --tag latest --push         # Build + push to server
#   bash eliza/packages/app-core/scripts/build-image.sh --remote                    # Build on eliza-core-1
#   bash eliza/packages/app-core/scripts/build-image.sh --version 2.0.0-alpha.54    # Build specific version
#
# Context:
#   - Repo:         $(git rev-parse --show-toplevel)
#   - Build server: ${BUILD_SERVER:-"root@your-server"} (eliza-core-1)
#   - Image name:   eliza/agent:{tag}
#
# What this does:
#   1. Patches packages/app/vite.config.ts to resolve @elizaos/* from node_modules
#      (the committed config points to Shaw's local ../eliza/ submodule)
#   2. Runs bun install --ignore-scripts
#   3. Runs npx tsdown to compile TypeScript → dist/
#   4. Builds the Vite UI → packages/app/dist/
#   5. Reverts the vite.config.ts patch (temp backup restore)
#   6. Runs docker build with the canonical container Dockerfile
#   7. Tags the image as eliza/agent:{tag}
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Build server config ───────────────────────────────────────────────────────
BUILD_SERVER="${BUILD_SERVER:-"root@your-build-server"}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=20"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "${BLUE}[build]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*" >&2; }
hdr()  { echo -e "\n${CYAN}${BOLD}━━━ $* ━━━${NC}"; }
die()  { err "$*"; exit 1; }

# ── Defaults ──────────────────────────────────────────────────────────────────
VERSION=""
TAG=""
REMOTE=false
DO_PUSH=false
DO_INSTALL=true
DO_TSDOWN=true
DRY_RUN=false

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --version)   VERSION="$2"; shift 2 ;;
    --tag)       TAG="$2"; shift 2 ;;
    --remote)    REMOTE=true; shift ;;
    --push)      DO_PUSH=true; shift ;;
    --no-install) DO_INSTALL=false; shift ;;
    --no-tsdown) DO_TSDOWN=false; shift ;;
    --dry-run)   DRY_RUN=true; shift ;;
    -h|--help)
      grep '^#' "$0" | head -30 | sed 's/^# \?//'
      exit 0 ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
done

load_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

sedi() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

# ── Verify we're in the eliza repo root ─────────────────────────────────
# Look for canonical markers: package.json with "elizaos" name and packages/app/vite.config.ts
if [[ ! -f "package.json" ]] || ! grep -q '"elizaos"' package.json 2>/dev/null; then
  die "Not in eliza repo root. Run from $(git rev-parse --show-toplevel)"
fi
if [[ ! -f "packages/app/vite.config.ts" ]]; then
  die "packages/app/vite.config.ts not found. Are you in the right directory?"
fi

REPO_ROOT="$(pwd)"
log "Repo root: ${YELLOW}${REPO_ROOT}${NC}"

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
SOURCE_SHA="$(git rev-parse HEAD)"

# ── Resolve version and tag ───────────────────────────────────────────────────
if [[ -z "$VERSION" ]]; then
  VERSION=$(node -e "process.stdout.write(require('./package.json').version)" 2>/dev/null \
    || python3 -c "import json; print(json.load(open('package.json'))['version'])")
fi
[[ -z "$VERSION" ]] && die "Could not determine version from package.json"

if [[ -z "$TAG" ]]; then
  TAG="v${VERSION}"
fi

IMAGE_NAME="${APP_IMAGE}:${TAG}"

log "Version: ${YELLOW}${VERSION}${NC}"
log "Tag:     ${YELLOW}${IMAGE_NAME}${NC}"
$DRY_RUN && warn "DRY RUN mode — commands will be shown but not executed"

# ── Select Dockerfile ─────────────────────────────────────────────────────────
if [[ -f "eliza/packages/app-core/deploy/Dockerfile.ci" ]]; then
  DOCKERFILE="eliza/packages/app-core/deploy/Dockerfile.ci"
  log "Dockerfile: ${YELLOW}${DOCKERFILE}${NC} (canonical production image)"
else
  die "No Dockerfile found. Expected eliza/packages/app-core/deploy/Dockerfile.ci."
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
run() {
  if $DRY_RUN; then
    echo -e "  ${CYAN}[dry-run]${NC} $*"
  else
    eval "$*"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Patch packages/app/vite.config.ts
#
# The committed config has:
#   elizaRoot = path.resolve(appRoot, "../eliza")  ← Shaw's local submodule
#   "packages/agent/src/index.ts"               ← monorepo path
#   "packages/app-core/src/index.ts"                 ← monorepo path
#   "packages/ui/src/index.ts"                       ← monorepo path
#
# We patch to:
#   elizaRoot = path.resolve(appRoot, "node_modules/@elizaos")
#   "agent/src/index.ts"   (packages/ prefix removed)
#   "app-core/src/index.ts"     (packages/ prefix removed)
#   "ui/dist/index.js"          (elizaos/ui ships compiled — use dist, not src)
#   "ui/src/index.ts"           (elizaos/ui is local source — keep src)
# ─────────────────────────────────────────────────────────────────────────────
hdr "Step 1: Patch vite.config.ts"

log "Applying node_modules resolution patch..."
VITE_CONFIG_BACKUP=""
if ! $DRY_RUN; then
  VITE_CONFIG_BACKUP="$(mktemp)"
  cp packages/app/vite.config.ts "$VITE_CONFIG_BACKUP"
fi

patch_vite() {
  local file="packages/app/vite.config.ts"

  # 1. elizaRoot: "../eliza" → "node_modules/@elizaos"
  #    This is the root cause — Shaw's local eliza checkout path → npm installed path
  sedi 's|path\.resolve(appRoot, "\.\./eliza")|path.resolve(appRoot, "node_modules/@elizaos")|g' "$file"

  # 2. Remove "packages/" prefix from elizaos/agent paths
  #    Both the index and wildcard variants (multi-line and single-line)
  sedi 's|"packages/agent/src/index\.ts"|"agent/src/index.ts"|g' "$file"
  sedi 's|"packages/agent/src/\$1"|"agent/src/$1"|g' "$file"
  # Also handle if $1 appears without backslash (sed single-quotes make $ literal)
  sedi 's|packages/agent/src/\$1|agent/src/$1|g' "$file"

  # 3. Remove "packages/" prefix from elizaos/app-core paths
  sedi 's|"packages/app-core/src/index\.ts"|"app-core/src/index.ts"|g' "$file"
  sedi 's|packages/app-core/src/\$1|app-core/src/$1|g' "$file"

  # 4. @elizaos/app-core → use dist/ (npm package ships compiled output, no src/)
  #    Target only lines that reference elizaRoot (not appRoot)
  sedi 's|path\.resolve(elizaRoot, "packages/ui/src/index\.ts")|path.resolve(elizaRoot, "ui/dist/index.js")|g' "$file"
  sedi 's|path\.resolve(elizaRoot, "packages/ui/src/\$1")|path.resolve(elizaRoot, "ui/dist/$1")|g' "$file"
  sedi 's|path\.resolve(elizaRoot, "packages/ui/src/\\\$1")|path.resolve(elizaRoot, "ui/dist/$1")|g' "$file"

  # 5. @elizaos/app-core → keep src/ (local repo source), just remove packages/ prefix
  sedi 's|path\.resolve(appRoot, "packages/ui/src/index\.ts")|path.resolve(appRoot, "ui/src/index.ts")|g' "$file"
  sedi 's|path\.resolve(appRoot, "packages/ui/src/\$1")|path.resolve(appRoot, "ui/src/$1")|g' "$file"
  sedi 's|path\.resolve(appRoot, "packages/ui/src/\\\$1")|path.resolve(appRoot, "ui/src/$1")|g' "$file"
}

if $DRY_RUN; then
  warn "[dry-run] Would patch packages/app/vite.config.ts (elizaRoot → node_modules, packages/ prefix removal)"
else
  patch_vite
  # Quick sanity check: make sure "../eliza" is gone
  if grep -q '"../eliza"' packages/app/vite.config.ts; then
    die "vite config patch failed — '../eliza' still present in vite.config.ts"
  fi
  ok "vite.config.ts patched"
  # Show what changed
  git diff packages/app/vite.config.ts | grep '^[+-]' | grep -v '^---\|^+++' | head -20 || true
fi

# Set up cleanup trap: always revert the vite config patch, even on error
DOCKERIGNORE_BACKUP=""
HAD_ROOT_DOCKERIGNORE=0
cleanup() {
  local exit_code=$?
  if [[ -n "$DOCKERIGNORE_BACKUP" ]] && [[ -f "$DOCKERIGNORE_BACKUP" ]] && ! $DRY_RUN; then
    log "Restoring .dockerignore..."
    if [[ "$HAD_ROOT_DOCKERIGNORE" == "1" ]]; then
      cp "$DOCKERIGNORE_BACKUP" .dockerignore 2>/dev/null || warn "Could not restore .dockerignore"
    else
      rm -f .dockerignore 2>/dev/null || true
    fi
    rm -f "$DOCKERIGNORE_BACKUP" 2>/dev/null || true
  fi
  if [[ -n "$VITE_CONFIG_BACKUP" ]] && [[ -f "$VITE_CONFIG_BACKUP" ]] && ! $DRY_RUN; then
    log "Reverting vite.config.ts patch..."
    cp "$VITE_CONFIG_BACKUP" packages/app/vite.config.ts 2>/dev/null || warn "Could not restore vite.config.ts from backup"
    rm -f "$VITE_CONFIG_BACKUP" 2>/dev/null || true
  fi
  if [[ $exit_code -ne 0 ]]; then
    err "Build failed (exit code $exit_code)"
  fi
}
trap cleanup EXIT

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Install dependencies
# --ignore-scripts: skip postinstall hooks that download models/binaries
#   (node-llama-cpp, etc.) — not needed for building
# ─────────────────────────────────────────────────────────────────────────────
hdr "Step 2: Install dependencies"

if $DO_INSTALL; then
  log "Running bun install --ignore-scripts..."
  run "NODE_LLAMA_CPP_SKIP_DOWNLOAD=true bun install --ignore-scripts 2>&1 | tail -10"
  ok "Dependencies installed"
else
  warn "Skipping bun install (--no-install)"
fi

hdr "Step 1_7b: Run postinstall patches"
run "SKIP_AVATAR_CLONE=1 ELIZA_NO_VISION_DEPS=1 bun run postinstall 2>&1 | tail -10"
ok "Postinstall patches complete"

hdr "Step 2c: Build Capacitor plugins"
run "bun packages/app-core/scripts/build-native-plugins.mjs"
ok "Capacitor plugins built"

hdr "Step 2d: Build workspace packages"
run "cd eliza/packages/agent && bun run build:docker-dist && cd ${REPO_ROOT}"
run "cd eliza/packages/core && bun run build:node && cd ${REPO_ROOT}"
ok "Workspace packages built"

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Build TypeScript with tsdown
# Compiles src/ → dist/ (entry.js, eliza.js, server.js, cli/*.js, etc.)
# ─────────────────────────────────────────────────────────────────────────────
hdr "Step 3: Build TypeScript (tsdown)"

if $DO_TSDOWN; then
  log "Running npx tsdown..."
  run "npx tsdown 2>&1 | tail -15"
  run "echo '{\"type\":\"module\"}' > dist/package.json"
  ok "tsdown complete"
else
  warn "Skipping tsdown (--no-tsdown)"
  [[ -d "dist" ]] || die "dist/ missing and --no-tsdown was set — need either tsdown or existing dist/"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 4: Build Vite UI
# packages/app/dist/ is the compiled React frontend served by the agent
# Must use the patched vite.config.ts (done in Step 1)
# ─────────────────────────────────────────────────────────────────────────────
hdr "Step 4: Build Vite UI"

log "Building Vite UI (packages/app)..."
run "cd packages/app && bun run build:web 2>&1 | tail -20 && cd ${REPO_ROOT}"

if ! $DRY_RUN && [[ ! -d "packages/app/dist" ]]; then
  die "packages/app/dist not found after vite build — check vite output above"
fi
ok "Vite UI built"

# ─────────────────────────────────────────────────────────────────────────────
# Step 5: Revert vite.config.ts patch
# The trap handles this on exit, but do it explicitly here too for clarity
# ─────────────────────────────────────────────────────────────────────────────
hdr "Step 5: Revert vite.config.ts"

if ! $DRY_RUN; then
  cp "$VITE_CONFIG_BACKUP" packages/app/vite.config.ts
  ok "vite.config.ts restored to original state"
else
  warn "[dry-run] Would revert vite.config.ts"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 6: Docker build
# ─────────────────────────────────────────────────────────────────────────────
hdr "Step 6: Docker build → ${IMAGE_NAME}"

# Stamp the version into build-args so the image knows its own version
BUILD_ARGS=(
  "--build-arg" "VERSION=v${VERSION#v}"
  "--build-arg" "VERSION_CLEAN=${VERSION#v}"
  "--build-arg" "REVISION=${SOURCE_SHA}"
  "--build-arg" "APP_ENTRYPOINT=${APP_ENTRYPOINT}"
  "--build-arg" "APP_CMD_START=${APP_CMD_START}"
  "--build-arg" "APP_PORT=${APP_PORT}"
  "--build-arg" "APP_API_BIND=${APP_API_BIND}"
  "--build-arg" "OCI_SOURCE=${OCI_SOURCE}"
  "--build-arg" "OCI_TITLE=${OCI_TITLE}"
  "--build-arg" "OCI_DESCRIPTION=${OCI_DESCRIPTION}"
  "--build-arg" "OCI_LICENSES=${OCI_LICENSES}"
)

if [[ "$DOCKERFILE" == "eliza/packages/app-core/deploy/Dockerfile.ci" ]]; then
  [[ -f "eliza/packages/app-core/deploy/.dockerignore.ci" ]] || die "eliza/packages/app-core/deploy/.dockerignore.ci is required for Dockerfile.ci builds"
  if $DRY_RUN; then
    warn "[dry-run] Would copy eliza/packages/app-core/deploy/.dockerignore.ci → .dockerignore for Dockerfile.ci"
  else
    DOCKERIGNORE_BACKUP="$(mktemp)"
    if [[ -f .dockerignore ]]; then
      HAD_ROOT_DOCKERIGNORE=1
      cp .dockerignore "$DOCKERIGNORE_BACKUP"
    else
      : >"$DOCKERIGNORE_BACKUP"
    fi
    cp eliza/packages/app-core/deploy/.dockerignore.ci .dockerignore
    ok "Using eliza/packages/app-core/deploy/.dockerignore.ci for canonical image build"
  fi
fi

if $REMOTE; then
  # ── Remote build on eliza-core-1 ───────────────────────────────────────
  log "Remote build on ${BUILD_SERVER}..."

  REMOTE_BUILD_DIR="/tmp/eliza-build-$(date +%s)"
  TARBALL="/tmp/eliza-image-build-$$.tar.gz"

  log "Creating build context tarball (excluding node_modules, .git)..."
  run "tar \
    --exclude='./node_modules' \
    --exclude='./.git' \
    --exclude='./packages/app/node_modules' \
    --exclude='./apps/home/node_modules' \
    --exclude='./packages/homepage/node_modules' \
    --exclude='./apps/ui/node_modules' \
    --exclude='./deploy/node_modules' \
    --exclude='./coverage' \
    --exclude='./.avatar-clone-tmp' \
    -czf '${TARBALL}' ."
  
  if ! $DRY_RUN; then
    TARBALL_SIZE=$(du -sh "${TARBALL}" | cut -f1)
    ok "Build context: ${TARBALL_SIZE}"
  fi

  log "SCP-ing build context to ${BUILD_SERVER}:${REMOTE_BUILD_DIR}..."
  run "ssh ${SSH_OPTS} -i '${SSH_KEY}' ${BUILD_SERVER} 'mkdir -p ${REMOTE_BUILD_DIR}'"
  run "scp -i '${SSH_KEY}' ${SSH_OPTS} '${TARBALL}' '${BUILD_SERVER}:${REMOTE_BUILD_DIR}/build.tar.gz'"
  run "rm -f '${TARBALL}'"

  log "Building on remote..."
  REMOTE_BUILD_ARGS=""
  for arg in "${BUILD_ARGS[@]}"; do
    REMOTE_BUILD_ARGS+=" $(printf '%q' "$arg")"
  done
  REMOTE_SCRIPT=$(cat <<SCRIPT
set -e
cd ${REMOTE_BUILD_DIR}
tar -xzf build.tar.gz
rm build.tar.gz
echo "[remote] Extracted build context"
docker build -f $(printf '%q' "${DOCKERFILE}")${REMOTE_BUILD_ARGS} \
  -t $(printf '%q' "${IMAGE_NAME}") \
  . 2>&1 | tail -30
echo "[remote] Build complete"
docker images '${IMAGE_NAME}' --format 'Image ready: {{.Repository}}:{{.Tag}} ({{.Size}})'
rm -rf ${REMOTE_BUILD_DIR}
SCRIPT
)
  run "ssh ${SSH_OPTS} -i '${SSH_KEY}' ${BUILD_SERVER} \"${REMOTE_SCRIPT}\""
  ok "Remote build complete: ${IMAGE_NAME} on ${BUILD_SERVER}"

else
  # ── Local build ──────────────────────────────────────────────────────────
  log "Building locally..."
  BUILD_CMD="docker build -f '${DOCKERFILE}'"
  for arg in "${BUILD_ARGS[@]}"; do
    BUILD_CMD+=" ${arg}"
  done
  BUILD_CMD+=" -t '${IMAGE_NAME}' ."

  run "${BUILD_CMD}"

  if ! $DRY_RUN; then
    FINAL_SIZE=$(docker images "${IMAGE_NAME}" --format "{{.Size}}" 2>/dev/null || echo "?")
    ok "Image built: ${IMAGE_NAME} (${FINAL_SIZE})"
  fi

  # ── Optionally push to eliza-core-1 ─────────────────────────────────────
  if $DO_PUSH && ! $DRY_RUN; then
    hdr "Pushing image to ${BUILD_SERVER}"
    log "docker save | ssh docker load (this may take a minute)..."
    run "docker save '${IMAGE_NAME}' | ssh ${SSH_OPTS} -i '${SSH_KEY}' ${BUILD_SERVER} 'docker load'"
    ok "Image loaded on ${BUILD_SERVER}"
  elif $DO_PUSH && $DRY_RUN; then
    warn "[dry-run] Would push ${IMAGE_NAME} to ${BUILD_SERVER}"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────────────────────────────────────
echo ""
ok "${BOLD}Build complete!${NC}"
echo -e "  Image:   ${GREEN}${IMAGE_NAME}${NC}"
echo -e "  Version: ${YELLOW}${VERSION}${NC}"
if $REMOTE; then
  echo -e "  Built on: ${CYAN}${BUILD_SERVER}${NC}"
  echo ""
  echo -e "  To deploy:  ${YELLOW}bash eliza/packages/app-core/scripts/deploy-image.sh --all --image ${IMAGE_NAME}${NC}"
elif $DO_PUSH; then
  echo -e "  Pushed to: ${CYAN}${BUILD_SERVER}${NC}"
  echo ""
  echo -e "  To deploy:  ${YELLOW}bash eliza/packages/app-core/scripts/deploy-image.sh --all --image ${IMAGE_NAME}${NC}"
else
  echo ""
  echo -e "  To push:    ${YELLOW}bash eliza/packages/app-core/scripts/build-image.sh --tag ${TAG} --push${NC}"
  echo -e "  To deploy:  ${YELLOW}bash eliza/packages/app-core/scripts/deploy-image.sh --all --image ${IMAGE_NAME}${NC}"
fi
