#!/usr/bin/env bash
# Day-0 verification: APOLLO+FSDP works, all 3 quant scripts work, eliza_bench
# scores ≥ acceptance gate. Exit non-zero on any verification failure.
#
# Run on the local box (orchestrator), not on the Vast instance.
#
# Required env: VAST_API_KEY, instance id in .vast_instance_id
#
# Optional env (parametrized so the same script smokes 2B / 9B / 27B):
#   REGISTRY_KEY      default: qwen3.5-2b
#                     supported: qwen3.5-2b | qwen3.5-9b | qwen3.6-27b
#   FSDP_WORLD_SIZE   default: matches the registry's recommended world size
#                     (1 for 2B/9B on a single GPU, 2 for 27B FSDP).
#   SMOKE_MAX_SAMPLES default: 32 (2B), 16 (9B), 8 (27B)
#   SMOKE_MAX_SEQ_LEN default: 2048 (2B), 4096 (9B), 8192 (27B)
#   SMOKE_BENCH_PER_BUCKET  default: 32 (2B/9B), 16 (27B)
#
# Usage:
#   bash scripts/day0_smoke.sh                          # 2B
#   REGISTRY_KEY=qwen3.5-9b bash scripts/day0_smoke.sh  # 9B (needs ≥80 GB GPU)
#   REGISTRY_KEY=qwen3.6-27b bash scripts/day0_smoke.sh # 27B (needs ≥190 GB cluster)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTANCE_ID="$(cat "$ROOT/.vast_instance_id")"
SSH="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"

REGISTRY_KEY="${REGISTRY_KEY:-qwen3.5-2b}"

# Per-size defaults (caller can override any of them via env).
case "$REGISTRY_KEY" in
  qwen3.5-2b)
    BASE_HF_ID="Qwen/Qwen3.5-2B"
    DEFAULT_FSDP_WORLD_SIZE=1
    DEFAULT_MAX_SAMPLES=32
    DEFAULT_MAX_SEQ_LEN=2048
    DEFAULT_BENCH_PER_BUCKET=32
    DEFAULT_OPTIMIZER=apollo_mini
    ;;
  qwen3.5-9b)
    BASE_HF_ID="Qwen/Qwen3.5-9B"
    DEFAULT_FSDP_WORLD_SIZE=1
    DEFAULT_MAX_SAMPLES=16
    DEFAULT_MAX_SEQ_LEN=4096
    DEFAULT_BENCH_PER_BUCKET=32
    DEFAULT_OPTIMIZER=apollo
    ;;
  qwen3.6-27b)
    BASE_HF_ID="Qwen/Qwen3.6-27B"
    DEFAULT_FSDP_WORLD_SIZE=2
    DEFAULT_MAX_SAMPLES=8
    DEFAULT_MAX_SEQ_LEN=8192
    DEFAULT_BENCH_PER_BUCKET=16
    DEFAULT_OPTIMIZER=apollo_mini
    ;;
  *)
    echo "[day0] unknown REGISTRY_KEY=$REGISTRY_KEY (supported: qwen3.5-2b, qwen3.5-9b, qwen3.6-27b)" >&2
    exit 2
    ;;
esac

FSDP_WORLD_SIZE="${FSDP_WORLD_SIZE:-$DEFAULT_FSDP_WORLD_SIZE}"
SMOKE_MAX_SAMPLES="${SMOKE_MAX_SAMPLES:-$DEFAULT_MAX_SAMPLES}"
SMOKE_MAX_SEQ_LEN="${SMOKE_MAX_SEQ_LEN:-$DEFAULT_MAX_SEQ_LEN}"
SMOKE_BENCH_PER_BUCKET="${SMOKE_BENCH_PER_BUCKET:-$DEFAULT_BENCH_PER_BUCKET}"
SMOKE_OPTIMIZER="${SMOKE_OPTIMIZER:-$DEFAULT_OPTIMIZER}"

# Run name encodes the registry key so concurrent smokes for different
# sizes don't trample each other's checkpoints/benchmarks.
RUN_NAME="${RUN_NAME:-${REGISTRY_KEY//./-}-apollo-smoke}"

# Resolve SSH endpoint
read -r REMOTE_USER REMOTE_HOST REMOTE_PORT < <(
    cd "$ROOT" && python3 -m scripts.lib.vast ssh "$INSTANCE_ID"
)
SSH_TARGET="$REMOTE_USER@$REMOTE_HOST"
SSH_PORT="$REMOTE_PORT"
echo "[day0] target: $SSH_TARGET:$SSH_PORT"
echo "[day0] config: registry=$REGISTRY_KEY base=$BASE_HF_ID world=$FSDP_WORLD_SIZE samples=$SMOKE_MAX_SAMPLES seq=$SMOKE_MAX_SEQ_LEN run=$RUN_NAME"

ssh_run() {
    $SSH -p "$SSH_PORT" "$SSH_TARGET" "$@"
}

# ---------- 1. Sync minimal training tree ----------
echo "[day0] step 1/6: sync code + smoke split"
rsync -avh --partial \
    -e "ssh -p $SSH_PORT -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR" \
    "$ROOT/scripts" "$ROOT/pyproject.toml" "$ROOT/uv.lock" "$ROOT/datasets.yaml" \
    "$SSH_TARGET:/workspace/training/" 2>&1 | tail -3
ssh_run "mkdir -p /workspace/training/data"
rsync -avh --partial \
    -e "ssh -p $SSH_PORT -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR" \
    "$ROOT/data/smoke" \
    "$SSH_TARGET:/workspace/training/data/" 2>&1 | tail -3

# ---------- 2. Install deps ----------
echo "[day0] step 2/6: uv sync --extra train"
ssh_run "cd /workspace/training && export PATH=\$HOME/.local/bin:\$PATH && uv sync --extra train" 2>&1 | tail -5

# ---------- 3. Train with APOLLO ± FSDP ----------
echo "[day0] step 3/6: train $REGISTRY_KEY ($SMOKE_OPTIMIZER, world=$FSDP_WORLD_SIZE, Liger)"
TRAIN_CMD="cd /workspace/training && \
    export PATH=\$HOME/.local/bin:\$PATH && \
    export HF_HOME=/workspace/hf-cache && \
    export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True && \
    uv run --extra train accelerate launch \
        --num_processes $FSDP_WORLD_SIZE --mixed_precision bf16 \
        --use_fsdp \
        --fsdp_sharding_strategy FULL_SHARD \
        --fsdp_state_dict_type SHARDED_STATE_DICT \
        --fsdp_offload_params false \
        --fsdp_cpu_ram_efficient_loading true \
        --fsdp_sync_module_states true \
        --fsdp_use_orig_params true \
        --fsdp_auto_wrap_policy TRANSFORMER_BASED_WRAP \
        --fsdp_transformer_layer_cls_to_wrap Qwen3_5DecoderLayer \
        --fsdp_backward_prefetch BACKWARD_PRE \
        scripts/train_local.py \
            --registry-key $REGISTRY_KEY \
            --train-file data/smoke/train.jsonl \
            --val-file data/smoke/val.jsonl \
            --run-name $RUN_NAME \
            --epochs 1 --lr 1e-5 --full-finetune --use-liger on \
            --max-samples $SMOKE_MAX_SAMPLES --max-seq-len $SMOKE_MAX_SEQ_LEN \
            --optimizer $SMOKE_OPTIMIZER \
        > /workspace/train.log 2>&1 && \
    touch /workspace/train.ok"

ssh_run "tmux kill-session -t train 2>/dev/null; tmux new -d -s train \"$TRAIN_CMD\""
echo "[day0]   tmux 'train' launched; polling…"
while ssh_run "tmux ls 2>/dev/null | grep -q train"; do sleep 30; done
if ! ssh_run "test -f /workspace/train.ok"; then
    echo "[day0] FAIL: training did not write success sentinel"
    ssh_run "tail -40 /workspace/train.log"
    exit 1
fi
echo "[day0] ✅ training succeeded"

# ---------- 4. Quantize ----------
echo "[day0] step 4/6: quantize (PolarQuant + fused_TurboQuant + QJL)"
for q in polarquant fused_turboquant qjl; do
    echo "[day0]   ⇢ $q"
    QUANT_CMD="cd /workspace/training && export PATH=\$HOME/.local/bin:\$PATH && \
        uv run --extra train python scripts/quantization/${q}_apply.py \
            --model checkpoints/$RUN_NAME/final \
            --output checkpoints/$RUN_NAME/final-${q} \
            --calibration data/smoke/val.jsonl \
            --calibration-samples 16 \
        > /workspace/quant_${q}.log 2>&1 && touch /workspace/quant_${q}.ok"
    ssh_run "tmux kill-session -t q 2>/dev/null; tmux new -d -s q \"$QUANT_CMD\""
    while ssh_run "tmux ls 2>/dev/null | grep -q ' q:'"; do sleep 15; done
    if ! ssh_run "test -f /workspace/quant_${q}.ok"; then
        echo "[day0] FAIL: $q did not produce success sentinel"
        ssh_run "tail -40 /workspace/quant_${q}.log"
        exit 1
    fi
    echo "[day0] ✅ $q done"
done

# ---------- 5. eliza_bench on base + finetuned + each quant variant ----------
echo "[day0] step 5/6: eliza_bench (base + 4 variants, max_per_bucket=$SMOKE_BENCH_PER_BUCKET)"
BENCH_CMD="set -e; cd /workspace/training && export PATH=\$HOME/.local/bin:\$PATH && \
    export HF_HOME=/workspace/hf-cache && \
    for variant in base finetuned final-polarquant final-fused_turboquant final-qjl; do \
        if [ \"\$variant\" = base ]; then \
            model_arg='--model $BASE_HF_ID'; out=base; \
        elif [ \"\$variant\" = finetuned ]; then \
            model_arg='--model checkpoints/$RUN_NAME/final --base-model $BASE_HF_ID'; out=finetuned; \
        else \
            ckpt_dir=checkpoints/$RUN_NAME/\$variant; \
            if [ ! -d \"\$ckpt_dir\" ]; then echo \"skip \$variant — not produced\"; continue; fi; \
            model_arg=\"--model \$ckpt_dir --base-model $BASE_HF_ID\"; out=\$variant; \
        fi; \
        echo \"=== bench \$variant ===\"; \
        uv run --extra train python scripts/benchmark/eliza_bench.py \\
            \$model_arg \\
            --test-file data/smoke/val.jsonl \\
            --max-per-bucket $SMOKE_BENCH_PER_BUCKET \\
            --out-dir benchmarks/$RUN_NAME/\$out \\
            >/workspace/bench_\$out.log 2>&1; \
    done && touch /workspace/bench.ok"

ssh_run "tmux kill-session -t bench 2>/dev/null; tmux new -d -s bench \"$BENCH_CMD\""
while ssh_run "tmux ls 2>/dev/null | grep -q bench"; do sleep 30; done
if ! ssh_run "test -f /workspace/bench.ok"; then
    echo "[day0] FAIL: bench did not write success sentinel"
    exit 1
fi
echo "[day0] ✅ bench done"

# ---------- 6. Fetch results + acceptance gate ----------
echo "[day0] step 6/6: fetch + check acceptance gate"
mkdir -p "$ROOT/benchmarks/$RUN_NAME"
rsync -avh \
    -e "ssh -p $SSH_PORT -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR" \
    "$SSH_TARGET:/workspace/training/benchmarks/$RUN_NAME/" \
    "$ROOT/benchmarks/$RUN_NAME/" 2>&1 | tail -3

# Acceptance gate: format_ok ≥ 95% on each quant variant. Same gate
# applies to all 3 sizes — quantization quality is independent of model
# size at this token budget.
RUN_NAME="$RUN_NAME" DAY0_ROOT="$ROOT" python3 - <<'PYEOF'
import json, os, sys, glob
run_name = os.environ["RUN_NAME"]
root = os.environ.get("DAY0_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fail = False
glob_path = os.path.join(root, "benchmarks", run_name, "*", "results.json")
paths = sorted(glob.glob(glob_path))
if not paths:
    print(f"  no results found under {glob_path}")
    sys.exit(1)
for path in paths:
    variant = os.path.basename(os.path.dirname(path))
    try:
        d = json.load(open(path))
    except Exception as e:
        print(f"  {variant}: cannot read results: {e}")
        fail = True
        continue
    by_bucket = d.get("by_bucket", {})
    print(f"  {variant}:")
    for b, r in by_bucket.items():
        fmt_pct = r.get("format_pct", 0)
        cnt_pct = r.get("content_pct", 0)
        marker = "OK" if fmt_pct >= 95 else "FAIL"
        print(f"    [{marker}] {b}: format={fmt_pct:.1f}%, content={cnt_pct:.1f}%, n={r.get('n', 0)}")
        if "polarquant" in variant or "turboquant" in variant or "qjl" in variant:
            if fmt_pct < 95:
                fail = True
sys.exit(1 if fail else 0)
PYEOF
status=$?
if [ $status -eq 0 ]; then
    echo "[day0] ALL CHECKS PASSED ($REGISTRY_KEY)"
else
    echo "[day0] acceptance gate failed ($REGISTRY_KEY)"
fi
exit $status
