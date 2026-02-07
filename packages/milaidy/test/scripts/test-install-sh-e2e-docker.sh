#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${MILAIDY_INSTALL_E2E_IMAGE:-milaidy-install-e2e:local}"
INSTALL_URL="${MILAIDY_INSTALL_URL:-https://milaidy.bot/install.sh}"

OPENAI_API_KEY="${OPENAI_API_KEY:-}"
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
ANTHROPIC_API_TOKEN="${ANTHROPIC_API_TOKEN:-}"
MILAIDY_E2E_MODELS="${MILAIDY_E2E_MODELS:-}"

echo "==> Build image: $IMAGE_NAME"
docker build \
  -t "$IMAGE_NAME" \
  -f "$ROOT_DIR/scripts/docker/install-sh-e2e/Dockerfile" \
  "$ROOT_DIR/scripts/docker/install-sh-e2e"

echo "==> Run E2E installer test"
docker run --rm \
  -e MILAIDY_INSTALL_URL="$INSTALL_URL" \
  -e MILAIDY_INSTALL_TAG="${MILAIDY_INSTALL_TAG:-latest}" \
  -e MILAIDY_E2E_MODELS="$MILAIDY_E2E_MODELS" \
  -e MILAIDY_INSTALL_E2E_PREVIOUS="${MILAIDY_INSTALL_E2E_PREVIOUS:-}" \
  -e MILAIDY_INSTALL_E2E_SKIP_PREVIOUS="${MILAIDY_INSTALL_E2E_SKIP_PREVIOUS:-0}" \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e ANTHROPIC_API_TOKEN="$ANTHROPIC_API_TOKEN" \
  "$IMAGE_NAME"
