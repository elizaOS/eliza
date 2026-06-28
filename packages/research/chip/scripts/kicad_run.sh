#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_KICAD="${ELIZA_KICAD_LOCAL_ROOT:-$ROOT/.tools/kicad-local}"
IMAGE="${ELIZA_KICAD_IMAGE:-eliza-chip-kicad-tools:local}"
DOCKER_TIMEOUT="${ELIZA_KICAD_DOCKER_TIMEOUT:-180}"

if [ "$#" -lt 1 ]; then
  echo "usage: scripts/kicad_run.sh <tool> [args...]" >&2
  exit 64
fi

tool="$1"
shift

if [ -x "$LOCAL_KICAD/usr/bin/$tool" ]; then
  export PATH="$LOCAL_KICAD/usr/bin:$PATH"
  export LD_LIBRARY_PATH="$LOCAL_KICAD/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
  export KICAD7_SYMBOL_DIR="$LOCAL_KICAD/usr/share/kicad/symbols"
  export KICAD7_FOOTPRINT_DIR="$LOCAL_KICAD/usr/share/kicad/footprints"
  export KICAD7_TEMPLATE_DIR="$LOCAL_KICAD/usr/share/kicad/template"
  exec "$LOCAL_KICAD/usr/bin/$tool" "$@"
fi

if command -v "$tool" >/dev/null 2>&1; then
  exec "$tool" "$@"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "$tool not found locally and docker is unavailable" >&2
  exit 127
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "KiCad tools image $IMAGE is missing. Run: make kicad-setup" >&2
  exit 1
fi

exec timeout "$DOCKER_TIMEOUT" docker run --rm \
  -u "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -e KICAD_CONFIG_HOME=/tmp/kicad-config \
  -e KICAD_CACHE_HOME=/tmp/kicad-cache \
  -v "$ROOT:/work" \
  -w /work \
  "$IMAGE" "$tool" "$@"
