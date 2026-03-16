#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${MILAIDY_IMAGE:-milaidy:local}"
CONFIG_DIR="${MILAIDY_CONFIG_DIR:-$HOME/.milaidy}"
WORKSPACE_DIR="${MILAIDY_WORKSPACE_DIR:-$HOME/.milaidy/workspace}"
PROFILE_FILE="${MILAIDY_PROFILE_FILE:-$HOME/.profile}"

PROFILE_MOUNT=()
if [[ -f "$PROFILE_FILE" ]]; then
  PROFILE_MOUNT=(-v "$PROFILE_FILE":/home/node/.profile:ro)
fi

echo "==> Build image: $IMAGE_NAME"
docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"

echo "==> Run live model tests (profile keys)"
docker run --rm -t \
  --entrypoint bash \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e HOME=/home/node \
  -e NODE_OPTIONS=--disable-warning=ExperimentalWarning \
  -e MILAIDY_LIVE_TEST=1 \
  -e MILAIDY_LIVE_MODELS="${MILAIDY_LIVE_MODELS:-all}" \
  -e MILAIDY_LIVE_PROVIDERS="${MILAIDY_LIVE_PROVIDERS:-}" \
  -e MILAIDY_LIVE_MODEL_TIMEOUT_MS="${MILAIDY_LIVE_MODEL_TIMEOUT_MS:-}" \
  -e MILAIDY_LIVE_REQUIRE_PROFILE_KEYS="${MILAIDY_LIVE_REQUIRE_PROFILE_KEYS:-}" \
  -v "$CONFIG_DIR":/home/node/.milaidy \
  -v "$WORKSPACE_DIR":/home/node/.milaidy/workspace \
  "${PROFILE_MOUNT[@]}" \
  "$IMAGE_NAME" \
  -lc "set -euo pipefail; [ -f \"$HOME/.profile\" ] && source \"$HOME/.profile\" || true; cd /app && pnpm test:live"
