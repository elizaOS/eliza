#!/usr/bin/env bash
set -euo pipefail

IMAGE="${ELIZA_KICAD_IMAGE:-eliza-chip-kicad-tools:local}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required when host kicad-cli is unavailable" >&2
  exit 127
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "KiCad tools image $IMAGE is missing. Run: make kicad-setup" >&2
  exit 1
fi

exec docker run --rm \
  -u "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -e KICAD_CONFIG_HOME=/tmp/kicad-config \
  -e KICAD_CACHE_HOME=/tmp/kicad-cache \
  -v "$ROOT:/work" \
  -w /work \
  "$IMAGE" "$@"
