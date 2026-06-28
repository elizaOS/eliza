#!/usr/bin/env bash
set -euo pipefail

IMAGE="${ELIZA_KICAD_IMAGE:-eliza-chip-kicad-tools:local}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_KICAD="${ELIZA_KICAD_LOCAL_ROOT:-$ROOT/.tools/kicad-local}"

if [ "$#" -gt 0 ] && [ -x "$LOCAL_KICAD/usr/bin/$1" ]; then
  export PATH="$LOCAL_KICAD/usr/bin:$PATH"
  export LD_LIBRARY_PATH="$LOCAL_KICAD/usr/lib/x86_64-linux-gnu:$LOCAL_KICAD/usr/lib:${LD_LIBRARY_PATH:-}"
  exec "$@"
fi

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
