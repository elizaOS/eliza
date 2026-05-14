#!/usr/bin/env bash
# runtime_graph_smoke.sh — prove a built llama.cpp fork can route KV cache
# kernels through real graph execution, not only ship standalone symbols.
#
# This is intentionally model-backed. If ELIZA_DFLASH_SMOKE_MODEL is absent,
# the smoke fails; a graph dispatch pass without a GGUF model would be a
# symbol check, not runtime verification.
#
# Driver: `llama-bench`, not `llama-cli`. The fork's `llama-cli` is
# conversation-only and busy-loops on stdin EOF (it has filled multi-GB log
# files in non-interactive use). `llama-bench --cache-type-k <type> -ngl 99`
# exercises the same prompt-eval + token-gen graph passes — including the
# Turbo/QJL/Polar KV-cache score+decode ops — and exits cleanly.
# `--gen-check` additionally runs `llama-completion` for a real GGUF
# next-token generation step.

set -euo pipefail

usage() {
    cat <<'USAGE' >&2
Usage:
  runtime_graph_smoke.sh --target <target> --backend-pattern <egrep> [options]

Required:
  --target            Build target, e.g. linux-x64-cuda, linux-x64-rocm.
  --backend-pattern   Extended grep regex that must appear in llama-bench logs
                      (CUDA|ggml_cuda, HIP|ROCm|ggml_hip, Vulkan|ggml_vulkan).

Options:
  --bin-dir <dir>     Override built binary directory.
  --model <path>      GGUF model path. Defaults to ELIZA_DFLASH_SMOKE_MODEL.
  --report-dir <dir>  Log/report directory. Defaults to verify/hardware-results.
  --cache-types <s>   Space/comma-separated cache type values to run. Defaults
                      to resolving all five families from llama-bench --help.
  --gen-check         Additionally run llama-completion for one real GGUF
                      next-token generation pass (default: bench-only).

Environment:
  ELIZA_STATE_DIR                 Defaults to ~/.eliza.
  ELIZA_DFLASH_SMOKE_MODEL        Required unless --model is passed.
  ELIZA_DFLASH_SMOKE_PROMPT       Defaults to a tiny deterministic prompt.
  ELIZA_DFLASH_SMOKE_TOKENS       Defaults to 4.
  ELIZA_DFLASH_SMOKE_NGL          Defaults to 99.
  ELIZA_DFLASH_SMOKE_EXTRA_ARGS   Extra llama-bench args, split on spaces.
  ELIZA_DFLASH_SMOKE_CACHE_TYPES  Overrides the default cache-family resolver.
  ELIZA_DFLASH_SMOKE_GEN_CHECK    Set to 1 to force --gen-check on.
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
GEN_CHECK="${ELIZA_DFLASH_SMOKE_GEN_CHECK:-0}"

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
        --gen-check)
            GEN_CHECK=1; shift ;;
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

resolve_bin() {
    local name="$1"
    if [[ -x "$BIN_DIR/$name" ]]; then printf '%s\n' "$BIN_DIR/$name"; return 0; fi
    if [[ -x "$BIN_DIR/$name.exe" ]]; then printf '%s\n' "$BIN_DIR/$name.exe"; return 0; fi
    return 1
}

BENCH="$(resolve_bin llama-bench || true)"
[[ -n "$BENCH" ]] || die "missing executable llama-bench in $BIN_DIR; rebuild target $TARGET (the build script ships llama-bench + llama-completion alongside llama-server)"

export LD_LIBRARY_PATH="$BIN_DIR:${LD_LIBRARY_PATH:-}"
export DYLD_LIBRARY_PATH="$BIN_DIR:${DYLD_LIBRARY_PATH:-}"
export PATH="$BIN_DIR:$PATH"

mkdir -p "$REPORT_DIR"

HELP_LOG="$REPORT_DIR/${TARGET}-llama-bench-help.log"
if ! "$BENCH" --help >"$HELP_LOG" 2>&1; then
    die "llama-bench --help failed; see $HELP_LOG"
fi
if ! grep -q -- "--cache-type-k" "$HELP_LOG"; then
    die "llama-bench help does not expose --cache-type-k; graph KV cache smoke cannot verify Turbo/QJL/Polar dispatch"
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
            die "llama-bench help does not advertise any cache-type alias for $family"
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
    echo "driver=llama-bench"
    echo "gen_check=$GEN_CHECK"
    echo "started_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "uname=$(uname -a 2>/dev/null || true)"
} >"$SUMMARY"

for run in "${RUNS[@]}"; do
    family="${run%%:*}"
    cache="${run#*:}"
    LOG="$REPORT_DIR/${TARGET}-${family}-${cache}.log"
    echo "[runtime_graph_smoke] target=$TARGET family=$family cache=$cache (llama-bench)"
    # llama-bench is non-interactive: it runs the prompt-eval + token-gen
    # graph passes and exits. -pg 16,8 keeps it tiny; -fa 1 enables the
    # flash-attn path the Turbo/QJL/Polar KV-cache ops live behind.
    if ! "$BENCH" \
        -m "$MODEL" \
        -ngl "$NGL" \
        --cache-type-k "$cache" \
        -p 16 -n "$TOKENS" -fa 1 -r 1 \
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

if [[ "$GEN_CHECK" == "1" ]]; then
    COMPLETION="$(resolve_bin llama-completion || true)"
    [[ -n "$COMPLETION" ]] || die "--gen-check requested but llama-completion missing in $BIN_DIR; rebuild target $TARGET"
    GEN_LOG="$REPORT_DIR/${TARGET}-gen-check.log"
    echo "[runtime_graph_smoke] target=$TARGET GGUF generation (llama-completion)"
    if ! "$COMPLETION" \
        -m "$MODEL" \
        -p "$PROMPT" \
        -n "$TOKENS" \
        -ngl "$NGL" \
        --no-warmup \
        "${EXTRA_ARGS[@]}" \
        >"$GEN_LOG" 2>&1; then
        echo "[runtime_graph_smoke] command log: $GEN_LOG" >&2
        die "llama-completion GGUF generation failed; see $GEN_LOG"
    fi
    if ! grep -Eiq "$BACKEND_PATTERN" "$GEN_LOG"; then
        echo "[runtime_graph_smoke] command log: $GEN_LOG" >&2
        die "backend pattern '$BACKEND_PATTERN' not observed during GGUF generation"
    fi
    echo "PASS gen-check log=$GEN_LOG" >>"$SUMMARY"
fi

echo "finished_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"$SUMMARY"
echo "[runtime_graph_smoke] PASS target=$TARGET report=$SUMMARY"
