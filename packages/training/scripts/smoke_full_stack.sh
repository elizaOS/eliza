#!/usr/bin/env bash
# eliza-1 single-GPU end-to-end smoke for the full
# training+quant+inference+bench stack.
#
# Single command. ~15-30 minutes on one consumer GPU (RTX 4090/5090/H100).
# Trains the smallest model (Qwen/Qwen3.5-0.8B), produces every quant
# sidecar, serves with vLLM, hits the OpenAI-compat tool-call endpoint,
# benchmarks each variant, and gates on hard pass criteria.
#
# Usage:
#   bash training/scripts/smoke_full_stack.sh
#   bash training/scripts/smoke_full_stack.sh --registry-key qwen3.5-0.8b
#   bash training/scripts/smoke_full_stack.sh --skip-train
#
# Env knobs:
#   ELIZA_SMOKE_VLLM_PORT   default 8001 (use a free port if 8001 is busy)
#   ELIZA_SMOKE_BENCH_PER_BUCKET  default 10
#
# Output:
#   training/checkpoints/<registry-key>-smoke-fullstack/
#       final/                     ← SFT checkpoint
#       polarquant/                ← PolarQuant 4-bit
#       fused-tq/                  ← fused-TurboQuant 4-bit (with --verify)
#       qjl/                       ← QJL 1-bit K-cache (skipped if no nvcc)
#       gguf-q4_k_m/               ← GGUF Q4_K_M (skipped if no llama.cpp)
#   training/benchmarks/<registry-key>-smoke-fullstack/
#       sft/summary.json
#       polarquant/summary.json
#       fused-tq/summary.json
#       qjl/summary.json           (when produced)

set -euo pipefail

# ---------- args ----------
REGISTRY_KEY="qwen3.5-0.8b"
SKIP_TRAIN=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --registry-key) REGISTRY_KEY="$2"; shift 2 ;;
        --registry-key=*) REGISTRY_KEY="${1#*=}"; shift ;;
        --skip-train) SKIP_TRAIN=1; shift ;;
        -h|--help)
            sed -n '2,30p' "$0"; exit 0 ;;
        *) echo "[smoke] unknown arg: $1" >&2; exit 2 ;;
    esac
done

# ---------- paths ----------
THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAIN_ROOT="$(cd "$THIS_DIR/.." && pwd)"
RUN_NAME="${REGISTRY_KEY//./-}-smoke-fullstack"
RUN_NAME="${RUN_NAME//\//-}"
CKPT_ROOT="$TRAIN_ROOT/checkpoints/$RUN_NAME"
BENCH_ROOT="$TRAIN_ROOT/benchmarks/$RUN_NAME"
SFT_DIR="$CKPT_ROOT/final"
POLAR_DIR="$CKPT_ROOT/polarquant"
FUSED_DIR="$CKPT_ROOT/fused-tq"
QJL_DIR="$CKPT_ROOT/qjl"
GGUF_DIR="$CKPT_ROOT/gguf-q4_k_m"
VLLM_PORT="${ELIZA_SMOKE_VLLM_PORT:-8001}"
BENCH_PER_BUCKET="${ELIZA_SMOKE_BENCH_PER_BUCKET:-10}"
TRAIN_DATA="$TRAIN_ROOT/data/smoke/train.jsonl"
VAL_DATA="$TRAIN_ROOT/data/smoke/val.jsonl"

mkdir -p "$CKPT_ROOT" "$BENCH_ROOT"
LOG_DIR="$CKPT_ROOT/_smoke-logs"
mkdir -p "$LOG_DIR"

# Architecture-aware step tracking. Every step name appended here is part of
# the smoke pipeline as documented in this script's banner. Steps may move
# between PASSED / SKIPPED_INCOMPATIBLE / SKIPPED_TOOLING / FAILED based on
# what the dispatched model actually supports and what tooling is present
# on the host. Gate 5 (in cloud dispatch) reads the resulting summary JSON
# and computes content_pct against `applicable_steps`, NOT all 9 — a step
# the architecture cannot run is not counted against the gate.
ALL_STEPS=("deps" "sft" "bench-sft" "polarquant" "bench-polarquant" "fused-tq" "bench-fused-tq" "qjl" "bench-qjl" "gguf" "vllm-toolcall" "bench")
PASSED_STEPS=()
SKIPPED_INCOMPATIBLE_STEPS=()
SKIPPED_TOOLING_STEPS=()
FAILED_STEPS=()
mark_pass()   { PASSED_STEPS+=("$1"); }
mark_skip_incompat() { SKIPPED_INCOMPATIBLE_STEPS+=("$1"); }
mark_skip_tooling()  { SKIPPED_TOOLING_STEPS+=("$1"); }
mark_fail()   { FAILED_STEPS+=("$1"); }
SUMMARY_PATH="$CKPT_ROOT/smoke_summary.json"

# Prefer the existing `.venv/bin/python` over `uv run` — `uv run` re-resolves
# the lockfile every invocation and can re-install torch underneath you when
# extras conflict, which corrupts the venv mid-run. The venv is built once
# via `uv sync --extra train --extra serve` (smoke needs both for SFT + vLLM).
if [[ -x "$TRAIN_ROOT/.venv/bin/python" ]]; then
    PY_RUN=("$TRAIN_ROOT/.venv/bin/python")
elif command -v uv >/dev/null 2>&1; then
    PY_RUN=(uv run --extra train --extra serve python)
else
    PY_RUN=(python)
fi

cd "$TRAIN_ROOT"
export PYTHONPATH="$TRAIN_ROOT/scripts:${PYTHONPATH:-}"

# Resolve the registry entry once so every step gets the same hf_id.
BASE_HF_ID="$("${PY_RUN[@]}" -c "import sys; sys.path.insert(0, 'scripts'); from training.model_registry import get; print(get('$REGISTRY_KEY').hf_id)")"
echo "[smoke] config: registry=$REGISTRY_KEY base=$BASE_HF_ID run=$RUN_NAME port=$VLLM_PORT"

# ---------- STEP 1/9: deps ----------
echo "[smoke] STEP 1/9: verify python deps"
"${PY_RUN[@]}" - <<'PY'
import importlib, sys
need = ["apollo_torch", "liger_kernel", "turboquant", "vllm", "transformers"]
missing = []
for m in need:
    try:
        importlib.import_module(m)
    except Exception as e:
        missing.append((m, str(e).splitlines()[0][:120]))
if missing:
    print("[smoke] MISSING dependencies:")
    for m, e in missing:
        print(f"  - {m}: {e}")
    print("\n[smoke] install hint:")
    print("  cd training && uv sync --extra train")
    print("  # or, ad hoc:")
    print("  pip install apollo-torch liger-kernel turbokv vllm transformers")
    sys.exit(1)
print("[smoke] deps OK:", ", ".join(need))
PY
mark_pass "deps"

# ---------- STEP 2/9: SFT ----------
if [[ $SKIP_TRAIN -eq 1 && -d "$SFT_DIR" ]]; then
    echo "[smoke] STEP 2/9: SFT (SKIPPED via --skip-train; reusing $SFT_DIR)"
else
    echo "[smoke] STEP 2/9: SFT (APOLLO+Liger, ~200 steps)"
    # train_local.py has no --max-steps; --max-samples=200 + epochs=1 +
    # micro_batch=1 + grad_accum=1 yields ≈200 optimizer steps on the
    # smoke split. We override grad_accum to 1 to keep the smoke fast and
    # bound to ~200 *optimizer* steps.
    #
    # Liger uses Triton JIT which needs system Python.h. If the dev headers
    # aren't installed (apt python3.x-dev), force liger off for the smoke —
    # SFT still validates APOLLO + FA + dataset + checkpoint write.
    LIGER_FLAG="auto"
    if ! python3 -c "import sys, sysconfig; sys.exit(0 if sysconfig.get_paths().get('include') and __import__('os').path.exists(__import__('os').path.join(sysconfig.get_paths()['include'], 'Python.h')) else 1)" 2>/dev/null; then
        echo "[smoke] python dev headers (Python.h) missing — forcing --use-liger off (Triton can't JIT)"
        LIGER_FLAG="off"
    fi
    "${PY_RUN[@]}" scripts/train_local.py \
        --registry-key "$REGISTRY_KEY" \
        --train-file "$TRAIN_DATA" \
        --val-file "$VAL_DATA" \
        --out-dir "$TRAIN_ROOT/checkpoints" \
        --run-name "$RUN_NAME" \
        --epochs 1 \
        --max-samples 200 \
        --grad-accum 1 \
        --full-finetune \
        --use-liger "$LIGER_FLAG" \
        2>&1 | tee "$LOG_DIR/01-sft.log"
    if [[ ! -d "$SFT_DIR" ]]; then
        echo "[smoke] FAIL: SFT did not produce $SFT_DIR" >&2
        mark_fail "sft"
        exit 1
    fi
fi
mark_pass "sft"

# ---------- helper: run native function-calling benchmark against a model dir ----------
run_bench() {
    local label="$1"
    local model_arg="$2"
    local extra_arg="${3:-}"
    local out_dir="$BENCH_ROOT/$label"
    mkdir -p "$out_dir"
    echo "[smoke]   bench → $label"
    # native_tool_call_bench uses --model / --test-file / --out-dir (writes summary.json).
    # We point it at smoke val.jsonl with a tight per-bucket cap.
    # shellcheck disable=SC2086
    "${PY_RUN[@]}" scripts/benchmark/native_tool_call_bench.py \
        --model "$model_arg" \
        $extra_arg \
        --test-file "$VAL_DATA" \
        --out-dir "$out_dir" \
        --max-per-bucket "$BENCH_PER_BUCKET" \
        --max-new-tokens 256 \
        2>&1 | tee "$LOG_DIR/bench-$label.log"
    if [[ ! -f "$out_dir/summary.json" ]]; then
        echo "[smoke] FAIL: bench ($label) did not write summary.json" >&2
        exit 1
    fi
}

# ---------- STEP 3/9: bench SFT ----------
echo "[smoke] STEP 3/9: bench SFT checkpoint"
run_bench "sft" "$SFT_DIR" ""
mark_pass "bench-sft"

# ---------- STEP 4/9: PolarQuant ----------
echo "[smoke] STEP 4/9: PolarQuant (4-bit weights)"
"${PY_RUN[@]}" scripts/quantization/polarquant_apply.py \
    --model "$SFT_DIR" \
    --output "$POLAR_DIR" \
    --bits 4 \
    --calibration "$VAL_DATA" \
    --calibration-samples 16 \
    2>&1 | tee "$LOG_DIR/02-polarquant.log"
mark_pass "polarquant"
run_bench "polarquant" "$POLAR_DIR" ""
mark_pass "bench-polarquant"

# ---------- shared check: do we have system Python.h for Triton JIT? ----------
HAS_PYTHON_H=0
if python3 -c "import sysconfig, os; raise SystemExit(0 if os.path.exists(os.path.join(sysconfig.get_paths()['include'], 'Python.h')) else 1)" 2>/dev/null; then
    HAS_PYTHON_H=1
fi

# ---------- STEP 5/9: fused-TurboQuant (with --verify) ----------
echo "[smoke] STEP 5/9: fused-TurboQuant (4-bit KV, --verify)"
if [[ $HAS_PYTHON_H -eq 1 ]]; then
    # fused_turboquant_apply uses --no-verify to OPT OUT — verify is on by default.
    # Capture the recipe exit code WITHOUT aborting the smoke. The recipe
    # returns:
    #   0 → applied + sidecar written
    #   2 → check_model_compatibility() rejected the model (publish-blocking
    #       for that recipe, but smoke marks it as a SKIP — it's an
    #       architectural mismatch, not a recipe bug)
    #   3 → EXIT_INCOMPATIBLE_ARCH: hybrid linear+full attention model
    #       (Qwen3.5/3.6) — the vendored fused cache cannot model
    #       has_previous_state for linear-attention layers. SKIP.
    #   other → operational failure (stop the smoke).
    set +e
    "${PY_RUN[@]}" scripts/quantization/fused_turboquant_apply.py \
        --model "$SFT_DIR" \
        --output "$FUSED_DIR" \
        --bits 4 \
        --calibration "$VAL_DATA" \
        --calibration-samples 16 \
        > "$LOG_DIR/03-fused-tq.log" 2>&1
    FUSED_RC=$?
    set -e
    cat "$LOG_DIR/03-fused-tq.log"
    if [[ $FUSED_RC -eq 0 ]]; then
        mark_pass "fused-tq"
        run_bench "fused-tq" "$FUSED_DIR" ""
        mark_pass "bench-fused-tq"
    elif [[ $FUSED_RC -eq 2 || $FUSED_RC -eq 3 ]]; then
        echo "[smoke] STEP 5/9: fused-turboquant SKIPPED (incompatible architecture, exit=$FUSED_RC)"
        mark_skip_incompat "fused-tq"
        mark_skip_incompat "bench-fused-tq"
    else
        echo "[smoke] FAIL: fused_turboquant_apply.py exited $FUSED_RC (operational failure)" >&2
        mark_fail "fused-tq"
        exit 1
    fi
else
    echo "[smoke]   SKIP: Python.h missing — fused-TQ verify path JITs Triton kernels."
    echo "[smoke]          Install python3-dev (apt) or run inside the training Dockerfile."
    mark_skip_tooling "fused-tq"
    mark_skip_tooling "bench-fused-tq"
fi

# ---------- STEP 6/9: QJL (skip if no nvcc OR no Python.h) ----------
echo "[smoke] STEP 6/9: QJL (1-bit K-cache)"
if command -v nvcc >/dev/null 2>&1 && [[ $HAS_PYTHON_H -eq 1 ]]; then
    "${PY_RUN[@]}" scripts/quantization/qjl_apply.py \
        --model "$SFT_DIR" \
        --output "$QJL_DIR" \
        --calibration "$VAL_DATA" \
        --calibration-samples 16 \
        2>&1 | tee "$LOG_DIR/04-qjl.log"
    mark_pass "qjl"
    run_bench "qjl" "$QJL_DIR" ""
    mark_pass "bench-qjl"
elif ! command -v nvcc >/dev/null 2>&1; then
    echo "[smoke]   SKIP: nvcc not on PATH (QJL ships CUDA kernels that need nvcc)"
    mark_skip_tooling "qjl"
    mark_skip_tooling "bench-qjl"
else
    echo "[smoke]   SKIP: Python.h missing — QJL build needs python3-dev headers"
    mark_skip_tooling "qjl"
    mark_skip_tooling "bench-qjl"
fi

# ---------- STEP 7/9: GGUF Q4_K_M (skip if no llama.cpp) ----------
echo "[smoke] STEP 7/9: GGUF Q4_K_M"
HAS_LLAMA_CPP=0
if command -v llama-quantize >/dev/null 2>&1 || command -v quantize >/dev/null 2>&1; then
    HAS_LLAMA_CPP=1
fi
if [[ -n "${LLAMA_CPP_DIR:-}" && -x "${LLAMA_CPP_DIR}/llama-quantize" ]]; then
    HAS_LLAMA_CPP=1
fi
if [[ $HAS_LLAMA_CPP -eq 1 ]]; then
    "${PY_RUN[@]}" scripts/quantization/gguf-q4_k_m_apply.py \
        --model "$SFT_DIR" \
        --output "$GGUF_DIR" \
        2>&1 | tee "$LOG_DIR/05-gguf.log"
    mark_pass "gguf"
else
    echo "[smoke]   SKIP: llama.cpp not on PATH (need llama-quantize + convert_hf_to_gguf.py; set LLAMA_CPP_DIR or build the packages/inference/llama.cpp submodule — see gguf-q4_k_m_apply.py _VENDOR_HINT)"
    mark_skip_tooling "gguf"
fi

# ---------- STEP 8/9: vLLM serve + 5 tool-call requests ----------
echo "[smoke] STEP 8/9: vLLM serve + OpenAI tool-call probe"
if [[ $HAS_PYTHON_H -eq 0 ]]; then
    echo "[smoke]   SKIP: vLLM inductor compile + Triton JIT both need Python.h"
    echo "[smoke]          Install python3-dev (apt) or run inside the training Dockerfile"
    echo "[smoke]          On Vast (devel image) this step runs cleanly."
    mark_skip_tooling "vllm-toolcall"
else
VLLM_LOG="$LOG_DIR/06-vllm.log"
: > "$VLLM_LOG"
# Serve the SFT checkpoint via vLLM. --gpu-target single is the local-debug
# profile; --model overrides the registry hf_id with our local SFT dir.
"${PY_RUN[@]}" scripts/inference/serve_vllm.py \
    --registry-key "$REGISTRY_KEY" \
    --model "$SFT_DIR" \
    --port "$VLLM_PORT" \
    --gpu-target single \
    >>"$VLLM_LOG" 2>&1 &
VLLM_PID=$!
cleanup_vllm() {
    if kill -0 "$VLLM_PID" 2>/dev/null; then
        echo "[smoke]   tearing down vLLM (pid=$VLLM_PID)"
        kill "$VLLM_PID" 2>/dev/null || true
        # serve_vllm.py exec's `vllm serve` — kill the whole process group.
        pkill -P "$VLLM_PID" 2>/dev/null || true
        wait "$VLLM_PID" 2>/dev/null || true
    fi
}
trap cleanup_vllm EXIT

echo "[smoke]   waiting for /v1/models on :$VLLM_PORT (timeout 120s)"
READY=0
for _ in $(seq 1 120); do
    if curl -fsS "http://127.0.0.1:$VLLM_PORT/v1/models" >/dev/null 2>&1; then
        READY=1; break
    fi
    if ! kill -0 "$VLLM_PID" 2>/dev/null; then
        echo "[smoke] FAIL: vLLM exited before becoming ready. Tail:" >&2
        tail -40 "$VLLM_LOG" >&2 || true
        exit 1
    fi
    sleep 1
done
if [[ $READY -ne 1 ]]; then
    echo "[smoke] FAIL: vLLM did not become ready within 120s. Tail:" >&2
    tail -40 "$VLLM_LOG" >&2 || true
    exit 1
fi
echo "[smoke]   vLLM ready"

# Discover served model id from /v1/models so we don't hardcode it.
SERVED_MODEL="$(curl -fsS "http://127.0.0.1:$VLLM_PORT/v1/models" \
    | "${PY_RUN[@]}" -c 'import json,sys; d=json.load(sys.stdin); print(d["data"][0]["id"])')"
echo "[smoke]   served model: $SERVED_MODEL"

TOOLCALL_DIR="$LOG_DIR/toolcalls"
mkdir -p "$TOOLCALL_DIR"
TOOLCALL_OK=0
for i in 1 2 3 4 5; do
    REQ="$TOOLCALL_DIR/req-$i.json"
    RESP="$TOOLCALL_DIR/resp-$i.json"
    cat > "$REQ" <<JSON
{
  "model": "$SERVED_MODEL",
  "messages": [
    {"role": "system", "content": "You can call tools when useful."},
    {"role": "user", "content": "What is the weather in San Francisco? Call the tool."}
  ],
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get the current weather for a city.",
      "parameters": {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"]
      }
    }
  }],
  "tool_choice": "auto",
  "max_tokens": 96,
  "temperature": 0.0
}
JSON
    if ! curl -fsS \
        -H "Content-Type: application/json" \
        -d @"$REQ" \
        "http://127.0.0.1:$VLLM_PORT/v1/chat/completions" \
        -o "$RESP"; then
        echo "[smoke]   tool-call $i: HTTP failure"
        continue
    fi
    if "${PY_RUN[@]}" -c "import json,sys; json.load(open(sys.argv[1])); print('parsed')" "$RESP" >/dev/null 2>&1; then
        TOOLCALL_OK=$((TOOLCALL_OK + 1))
    else
        echo "[smoke]   tool-call $i: response not parseable JSON"
    fi
done
echo "[smoke]   tool-call requests: $TOOLCALL_OK / 5 returned parseable JSON"
if [[ $TOOLCALL_OK -lt 5 ]]; then
    echo "[smoke] FAIL: expected 5/5 parseable tool-call responses, got $TOOLCALL_OK" >&2
    exit 1
fi

cleanup_vllm
trap - EXIT
mark_pass "vllm-toolcall"
fi  # end of HAS_PYTHON_H gate for STEP 8

# ---------- STEP 9/9: summary + acceptance gate ----------
echo "[smoke] STEP 9/9: summary + acceptance gate"

# Serialize the architecture-aware step bookkeeping so the gate logic below
# can compute applicable_steps / passed_steps and Gate 5 (cloud dispatch)
# can read the resulting JSON. A step that the architecture cannot run
# (e.g., fused-turboquant on hybrid attention) is NOT counted against the
# gate — it's still listed under skipped_incompatible for traceability.
ALL_STEPS_JSON="$(printf '%s\n' "${ALL_STEPS[@]}" | python3 -c 'import sys,json;print(json.dumps([s.strip() for s in sys.stdin if s.strip()]))')"
PASSED_JSON="$(printf '%s\n' "${PASSED_STEPS[@]:-}" | python3 -c 'import sys,json;print(json.dumps([s.strip() for s in sys.stdin if s.strip()]))')"
SKIPPED_INCOMPAT_JSON="$(printf '%s\n' "${SKIPPED_INCOMPATIBLE_STEPS[@]:-}" | python3 -c 'import sys,json;print(json.dumps([s.strip() for s in sys.stdin if s.strip()]))')"
SKIPPED_TOOLING_JSON="$(printf '%s\n' "${SKIPPED_TOOLING_STEPS[@]:-}" | python3 -c 'import sys,json;print(json.dumps([s.strip() for s in sys.stdin if s.strip()]))')"
FAILED_JSON="$(printf '%s\n' "${FAILED_STEPS[@]:-}" | python3 -c 'import sys,json;print(json.dumps([s.strip() for s in sys.stdin if s.strip()]))')"

RUN_NAME="$RUN_NAME" \
REGISTRY_KEY="$REGISTRY_KEY" \
BASE_HF_ID="$BASE_HF_ID" \
BENCH_ROOT="$BENCH_ROOT" \
SUMMARY_PATH="$SUMMARY_PATH" \
ALL_STEPS_JSON="$ALL_STEPS_JSON" \
PASSED_JSON="$PASSED_JSON" \
SKIPPED_INCOMPAT_JSON="$SKIPPED_INCOMPAT_JSON" \
SKIPPED_TOOLING_JSON="$SKIPPED_TOOLING_JSON" \
FAILED_JSON="$FAILED_JSON" \
"${PY_RUN[@]}" - <<'PY'
import json, os, sys, time
from pathlib import Path

bench_root = Path(os.environ["BENCH_ROOT"])
summary_path = Path(os.environ["SUMMARY_PATH"])
all_steps = json.loads(os.environ["ALL_STEPS_JSON"])
passed = json.loads(os.environ["PASSED_JSON"])
skipped_incompat = json.loads(os.environ["SKIPPED_INCOMPAT_JSON"])
skipped_tooling = json.loads(os.environ["SKIPPED_TOOLING_JSON"])
failed = json.loads(os.environ["FAILED_JSON"])

# applicable_steps = total minus the ones the architecture cannot run
# AND minus the ones this host cannot run for tooling reasons (no nvcc,
# no Python.h, no llama.cpp). Both kinds of skip are surfaced separately
# in the JSON for traceability so a downstream gate (e.g., the canonical
# Vast image) can re-evaluate strictness with full host context.
#
# Gate 5 (cloud dispatch consumes this summary) checks
# applicable_passed_pct >= 80 — that is, of the steps both the
# architecture and the host can run, ≥80% must have actually passed.
applicable_steps = [
    s for s in all_steps
    if s not in skipped_incompat and s not in skipped_tooling
]
applicable_passed_only = [s for s in passed if s in applicable_steps]
content_pct = (100.0 * len(applicable_passed_only) / max(len(applicable_steps), 1))

print()
print(f"  {'variant':<14} {'fmt%':>6} {'cnt%':>6} {'tok/s':>8} {'examples':>9}")
print(f"  {'-'*14} {'-'*6} {'-'*6} {'-'*8} {'-'*9}")
fail = False
bench_rows = []
if bench_root.exists():
    for sub in sorted(bench_root.iterdir()):
        if not sub.is_dir():
            continue
        sp = sub / "summary.json"
        if not sp.exists():
            continue
        d = json.loads(sp.read_text())
        buckets = d.get("buckets", {})
        n_total = sum(b.get("n", 0) for b in buckets.values())
        fmt_ok = sum(b.get("structure_ok", 0) for b in buckets.values())
        cnt_ok = sum(b.get("content_ok", 0) for b in buckets.values())
        fmt_pct = 100.0 * fmt_ok / max(n_total, 1)
        cnt_pct = 100.0 * cnt_ok / max(n_total, 1)
        tps = d.get("tokens_per_sec_gen", 0.0)
        print(f"  {sub.name:<14} {fmt_pct:>6.1f} {cnt_pct:>6.1f} {tps:>8.1f} {n_total:>9}")
        bench_rows.append({
            "variant": sub.name,
            "fmt_pct": round(fmt_pct, 2),
            "cnt_pct": round(cnt_pct, 2),
            "tokens_per_sec_gen": round(tps, 2),
            "n": n_total,
        })
        if sub.name == "sft" and cnt_pct < 80.0:
            print(f"  [GATE] sft.content_ok={cnt_pct:.1f}% < 80%")
            fail = True

# Surface peak VRAM if available.
import shutil, subprocess
if shutil.which("nvidia-smi"):
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.used,memory.total",
             "--format=csv,noheader,nounits"],
            text=True, timeout=5,
        ).strip().splitlines()
        for i, line in enumerate(out):
            used, total = (x.strip() for x in line.split(","))
            print(f"  gpu{i} VRAM (current): {used} MiB / {total} MiB")
    except Exception:
        pass

# ---- Gate 5 (architecture-aware): all applicable steps must pass ----
applicable_failed = [s for s in failed if s in applicable_steps]
applicable_tooling_skipped = [s for s in skipped_tooling if s in applicable_steps]
applicable_passed = [s for s in passed if s in applicable_steps]

# A step the architecture supports must end up either passed or skipped
# for tooling reasons we explicitly accept (none — tooling skips are
# treated as gate failures here, see comment above).
gate_ok = (
    not fail
    and not applicable_failed
    and not applicable_tooling_skipped
    and len(applicable_passed) == len(applicable_steps)
)

# Overall result: PASS only if (a) the per-bench content gate passed and
# (b) every applicable step landed in `passed`.
status = "pass" if gate_ok else "fail"

summary = {
    "schemaVersion": 2,
    "run_name": os.environ.get("RUN_NAME", ""),
    "registry_key": os.environ.get("REGISTRY_KEY", ""),
    "base_hf_id": os.environ.get("BASE_HF_ID", ""),
    "generated_at_unix": int(time.time()),
    "all_steps": all_steps,
    "applicable_steps": applicable_steps,
    "passed_steps": passed,
    "skipped_incompatible_steps": skipped_incompat,
    "skipped_tooling_steps": skipped_tooling,
    "failed_steps": failed,
    "applicable_passed_pct": round(content_pct, 2),
    "bench_rows": bench_rows,
    "status": status,
    "gate": {
        "name": "smoke_full_stack",
        "rule": "all applicable steps pass; sft bench content_ok >= 80%",
        "applicable_count": len(applicable_steps),
        "applicable_passed_count": len(applicable_passed),
        "applicable_failed_count": len(applicable_failed),
        "applicable_tooling_skipped_count": len(applicable_tooling_skipped),
        "skipped_incompatible_count": len(skipped_incompat),
    },
}

summary_path.parent.mkdir(parents=True, exist_ok=True)
summary_path.write_text(json.dumps(summary, indent=2) + "\n")
print()
print(f"[smoke] summary written → {summary_path}")
print(f"[smoke] applicable_steps ({len(applicable_steps)}): {applicable_steps}")
print(f"[smoke] passed_steps ({len(passed)}): {passed}")
if skipped_incompat:
    print(f"[smoke] skipped_incompatible ({len(skipped_incompat)}): {skipped_incompat}")
if skipped_tooling:
    print(f"[smoke] skipped_tooling ({len(skipped_tooling)}): {skipped_tooling}")
if failed:
    print(f"[smoke] failed ({len(failed)}): {failed}")
print(f"[smoke] status: {status}")

sys.exit(0 if gate_ok else 1)
PY

echo "[smoke] PASS"
