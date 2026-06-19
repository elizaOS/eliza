#!/usr/bin/env sh
set -eu

REPO_DIR="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
CT_DIR="${CT_DIR:-$REPO_DIR/external/circuit_training}"
MP_DIR="${MP_DIR:-$REPO_DIR/external/MacroPlacement}"
IMAGE="${ALPHACHIP_IMAGE:-circuit_training:e1-r0.0.4}"

echo "AlphaChip setup status"
echo "repo: $REPO_DIR"

if [ -d "$CT_DIR/.git" ]; then
    printf 'circuit_training: '
    git -C "$CT_DIR" rev-parse --abbrev-ref HEAD
    git -C "$CT_DIR" rev-parse --short HEAD
else
    echo "circuit_training: MISSING at $CT_DIR"
fi

if [ -d "$MP_DIR/.git" ]; then
    if git -C "$MP_DIR" rev-parse --short HEAD >/dev/null 2>&1; then
        printf 'MacroPlacement: '
        git -C "$MP_DIR" rev-parse --short HEAD
    else
        echo "MacroPlacement: checkout present but no complete revision yet"
    fi
elif [ -f "$MP_DIR/PINNED_COMMIT" ] && [ -f "$MP_DIR/CodeElements/FormatTranslators/src/gen_pb_or.tcl" ]; then
    printf 'MacroPlacement: source archive '
    cat "$MP_DIR/PINNED_COMMIT"
else
    echo "MacroPlacement: MISSING at $MP_DIR"
fi

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "docker image: present ($IMAGE)"
else
    echo "docker image: missing ($IMAGE)"
fi

if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || true
else
    echo "nvidia-smi: missing"
fi

if command -v openlane >/dev/null 2>&1; then
    openlane --version || true
else
    echo "openlane: not on PATH"
fi

if command -v openroad >/dev/null 2>&1; then
    openroad -version || true
else
    echo "openroad: not on PATH"
fi
