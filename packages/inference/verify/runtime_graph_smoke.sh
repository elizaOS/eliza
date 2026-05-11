#!/usr/bin/env bash
# runtime_graph_smoke.sh — prove a built llama.cpp fork can route KV cache
# kernels through real graph execution, not only ship standalone symbols.
#
# This is intentionally model-backed. If ELIZA_DFLASH_SMOKE_MODEL is absent,
# the smoke fails; a graph dispatch pass without a GGUF model would be a
# symbol check, not runtime verification.

set -euo pipefail

usage() {
    cat <<'USAGE' >&2
Usage:
  runtime_graph_smoke.sh --target <target> --backend-pattern <egrep> [options]

Required:
  --target            Build target, e.g. linux-x64-cuda, linux-x64-rocm.
  --backend-pattern   Extended grep regex that must appear in llama-cli logs
                      (CUDA|ggml_cuda, HIP|ROCm|ggml_hip, Vulkan|ggml_vulkan).

Options:
  --bin-dir <dir>     Override built binary directory.
  --model <path>      GGUF model path. Defaults to ELIZA_DFLASH_SMOKE_MODEL.
  --report-dir <dir>  Log/report directory. Defaults to verify/hardware-results.
  --cache-types <s>   Space/comma-separated cache type values to run. Defaults
                      to resolving all five families from llama-cli --help.

Environment:
  ELIZA_STATE_DIR                 Defaults to ~/.eliza.
  ELIZA_DFLASH_SMOKE_MODEL        Required unless --model is passed.
  ELIZA_DFLASH_SMOKE_PROMPT       Defaults to a tiny deterministic prompt.
  ELIZA_DFLASH_SMOKE_TOKENS       Defaults to 4.
  ELIZA_DFLASH_SMOKE_NGL          Defaults to 99.
  ELIZA_DFLASH_SMOKE_EXTRA_ARGS   Extra llama-cli args, split on spaces.
  ELIZA_DFLASH_SMOKE_CACHE_TYPES  Overrides the default cache-family resolver.
USAGE
}

die() {
    echo "[runtime_graph_smoke] ERROR: $*" >&2
    exit 1
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET=""
BACKEND_PATTERN=""
BIN_DIR=""
MODEL="${ELIZA_DFLASH_SMOKE_MODEL:-}"
REPORT_DIR="${ELIZA_DFLASH_HARDWARE_REPORT_DIR:-$HERE/hardware-results}"
CACHE_TYPES="${ELIZA_DFLASH_SMOKE_CACHE_TYPES:-}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --target)
            TARGET="${2:-}"; shift 2 ;;
        --backend-pattern)
            BACKEND_PATTERN="${2:-}"; shift 2 ;;
        --bin-dir)
            BIN_DIR="${2:-}"; shift 2 ;;
        --model)
            MODEL="${2:-}"; shift 2 ;;
        --report-dir)
            REPORT_DIR="${2:-}"; shift 2 ;;
        --cache-types)
            CACHE_TYPES="${2:-}"; shift 2 ;;
        -h|--help)
            usage; exit 0 ;;
        *)
            usage; die "unknown argument: $1" ;;
    esac
done

[[ -n "$TARGET" ]] || { usage; die "--target is required"; }
[[ -n "$BACKEND_PATTERN" ]] || { usage; die "--backend-pattern is required"; }
[[ -n "$MODEL" ]] || die "ELIZA_DFLASH_SMOKE_MODEL / --model is required for graph dispatch verification"
[[ -f "$MODEL" ]] || die "model file not found: $MODEL"

if [[ -z "$BIN_DIR" ]]; then
    STATE_DIR="${ELIZA_STATE_DIR:-$HOME/.eliza}"
    BIN_DIR="$STATE_DIR/local-inference/bin/dflash/$TARGET"
fi

CLI="$BIN_DIR/llama-cli"
if [[ ! -x "$CLI" && -x "$BIN_DIR/llama-cli.exe" ]]; then
    CLI="$BIN_DIR/llama-cli.exe"
fi
[[ -x "$CLI" ]] || die "missing executable llama-cli in $BIN_DIR; build target $TARGET first"

export LD_LIBRARY_PATH="$BIN_DIR:${LD_LIBRARY_PATH:-}"
export DYLD_LIBRARY_PATH="$BIN_DIR:${DYLD_LIBRARY_PATH:-}"
export PATH="$BIN_DIR:$PATH"

mkdir -p "$REPORT_DIR"

HELP_LOG="$REPORT_DIR/${TARGET}-llama-cli-help.log"
if ! "$CLI" --help >"$HELP_LOG" 2>&1; then
    die "llama-cli --help failed; see $HELP_LOG"
fi
HELP="$(cat "$HELP_LOG")"
if ! grep -q -- "--cache-type-k" "$HELP_LOG"; then
    die "llama-cli help does not expose --cache-type-k; graph KV cache smoke cannot verify Turbo/QJL/Polar dispatch"
fi

resolve_cache_type() {
    local family="$1"; shift
    local alias
    for alias in "$@"; do
        if grep -Eiq "(^|[^[:alnum:]_+-])${alias}([^[:alnum:]_+-]|$)" "$HELP_LOG"; then
            printf '%s:%s\n' "$family" "$alias"
            return 0
        fi
    done
    return 1
}

declare -a RUNS=()
if [[ -n "$CACHE_TYPES" ]]; then
    CACHE_TYPES="${CACHE_TYPES//,/ }"
    for cache in $CACHE_TYPES; do
        RUNS+=("$cache:$cache")
    done
else
    for spec in \
        "turbo3 tbq3_0 turbo3" \
        "turbo4 tbq4_0 turbo4" \
        "turbo3_tcq tbq3_tcq turbo3_tcq turbo3-tcq" \
        "qjl qjl1_256 qjl_full qjl" \
        "polar q4_polar polarquant polar"; do
        # shellcheck disable=SC2206
        parts=($spec)
        family="${parts[0]}"
        if resolved="$(resolve_cache_type "$family" "${parts[@]:1}")"; then
            RUNS+=("$resolved")
        else
            die "llama-cli help does not advertise any cache-type alias for $family"
        fi
    done
fi

PROMPT="${ELIZA_DFLASH_SMOKE_PROMPT:-Eliza local backend graph dispatch smoke.}"
TOKENS="${ELIZA_DFLASH_SMOKE_TOKENS:-4}"
NGL="${ELIZA_DFLASH_SMOKE_NGL:-99}"
# shellcheck disable=SC2206
EXTRA_ARGS=(${ELIZA_DFLASH_SMOKE_EXTRA_ARGS:-})

SUMMARY="$REPORT_DIR/${TARGET}-graph-smoke.summary"
{
    echo "target=$TARGET"
    echo "bin_dir=$BIN_DIR"
    echo "model=$MODEL"
    echo "tokens=$TOKENS"
    echo "ngl=$NGL"
    echo "cache_runs=${RUNS[*]}"
    echo "backend_pattern=$BACKEND_PATTERN"
    echo "started_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "uname=$(uname -a 2>/dev/null || true)"
} >"$SUMMARY"

for run in "${RUNS[@]}"; do
    family="${run%%:*}"
    cache="${run#*:}"
    LOG="$REPORT_DIR/${TARGET}-${family}-${cache}.log"
    echo "[runtime_graph_smoke] target=$TARGET family=$family cache=$cache"
    if ! "$CLI" \
        -m "$MODEL" \
        -p "$PROMPT" \
        -n "$TOKENS" \
        -ngl "$NGL" \
        --cache-type-k "$cache" \
        "${EXTRA_ARGS[@]}" \
        >"$LOG" 2>&1; then
        echo "[runtime_graph_smoke] command log: $LOG" >&2
        exit 1
    fi
    if ! grep -Eiq "$BACKEND_PATTERN" "$LOG"; then
        echo "[runtime_graph_smoke] command log: $LOG" >&2
        die "backend pattern '$BACKEND_PATTERN' not observed for cache=$cache; refusing to count this as hardware dispatch"
    fi
    echo "PASS $family cache=$cache log=$LOG" >>"$SUMMARY"
done

echo "finished_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"$SUMMARY"
echo "[runtime_graph_smoke] PASS target=$TARGET report=$SUMMARY"
