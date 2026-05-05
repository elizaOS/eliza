# Training Plan — 2B / 9B / 27B Full FT on Vast.ai Blackwell

Verified, step-by-step plan to train Qwen3.5-2B, Qwen3.5-9B, and Qwen3.6-27B with the full APOLLO + Liger + FSDP + (post-train) PolarQuant + fused-TurboQuant + QJL stack on 2× RTX PRO 6000 Blackwell, then benchmark each against:

1. **eliza_bench** — TOON format + action-name conformance on the held-out test split (4 buckets: should_respond, message_handler, reply, claude_distill).
2. **BFCL** — Berkeley Function-Calling Leaderboard (the canonical action-calling benchmark).
3. **Tau-bench** — multi-turn agent behavior.
4. **AgentBench** — cross-domain tool use.

---

## 1. Why the smoke kept OOMing — and why 27B + APOLLO_mini does fit

Mathematical headroom check from `memory_calc.py` (Liger fused chunked-CE + activation checkpointing + FA-2 sdpa fallback):

| seq_len | optimizer | total mem | per-rank on 2× Blkw6000 (96 GB) | fits? |
|---|---|---:|---:|---|
| 8192 | adamw | 305 GB | 153 GB | **✗** |
| 8192 | apollo_mini | **128 GB** | **64 GB** (67% util) | ✅ |
| 16384 | apollo_mini | 134 GB | 67 GB (70% util) | ✅ |
| 32768 | apollo_mini | 140 GB | 70 GB (73% util) | ✅ |
| 65536 | apollo_mini | 154 GB | 77 GB (80% util) | ✅ tight |
| 131072 | apollo_mini | 180 GB | 90 GB (94% util) | ✗ |

The smoke fell back to AdamW because **APOLLO can't see 2-D weights once FSDP wraps params into `FlatParameter`s**. AdamW's optimizer state alone (8B/param × 27B = 201 GB) is bigger than the entire cluster.

**The fix is mechanical, not architectural.** Use FSDP1's `use_orig_params=True` mode — FSDP keeps the original `nn.Parameter` objects as views into the FlatParameter, so `model.named_parameters()` post-wrap still returns 2-D shapes. APOLLO's `_split_params` then routes them correctly.

---

## 2. Code changes required (all in `scripts/train_local.py`)

### 2.1 APOLLO+FSDP wiring

```python
# In create_optimizer override, replace the current eager builder with:
class _MiladySFTTrainer(SFTTrainer):
    def create_optimizer(self, model=None):
        if self.optimizer is None:
            target = model or self.model
            # use_orig_params=True keeps Parameter objects 2-D-shaped,
            # APOLLO's named_parameters() walk now finds the right matrices.
            assert any(p.dim() == 2 for n, p in target.named_parameters()), (
                "FSDP must be configured with use_orig_params=True for APOLLO"
            )
            self.optimizer = apollo_builder(target)
        return self.optimizer
```

### 2.2 Pass `--fsdp_use_orig_params true` from the launcher

Add to `scripts/train_vast.sh:run_remote()`:

```bash
accelerate launch \
    --use_fsdp \
    --fsdp_sharding_strategy FULL_SHARD \
    --fsdp_state_dict_type SHARDED_STATE_DICT \
    --fsdp_cpu_ram_efficient_loading true \
    --fsdp_sync_module_states true \
    --fsdp_auto_wrap_policy TRANSFORMER_BASED_WRAP \
    --fsdp_transformer_layer_cls_to_wrap Qwen3_5DecoderLayer \
    --fsdp_use_orig_params true \         # <-- the only new flag
    --fsdp_backward_prefetch BACKWARD_PRE \
    ...
```

### 2.3 Standardize on Liger-on, completion_only_loss-off

Already patched in v16 — `compute_loss` override falls back to `outputs.loss` when Liger sets logits=None. Keep.

### 2.4 attn_implementation auto-detect

Already patched — falls back to `sdpa` when flash_attn isn't available (Blackwell sm_120 has no FA-2 wheel; sdpa has flash backend at the kernel level so it's not a major loss).

---

## 3. Provision plan — one instance, three trainings, all benchmarks

Using `blkw6000-2x` ($1.34/hr) on Vast. Cost cap: ~$30 for the entire plan.

### 3.1 Provision

```bash
export VAST_API_KEY="..."
export REGISTRY_KEY="qwen3.6-27b"
export RUN_NAME="qwen36-27b-apollo"
export VAST_GPU_TARGET="blackwell6000-2x"
export VAST_DISK_GB=1024
bash scripts/train_vast.sh provision
```

Expected: ~10 min for provision + apt deps + uv install. Disk usage: ~5 GB for Python deps, ~50 GB per model in HF cache.

### 3.2 Sync minimal training tree

(skip the 22 GB `data/final/`; build per-size smoke + use streaming for the real run)

```bash
rsync -avh --partial \
    -e "ssh -p $PORT -o StrictHostKeyChecking=no" \
    scripts pyproject.toml uv.lock datasets.yaml \
    data/smoke data/together/smoke \
    root@$HOST:/workspace/training/
```

For the real training data, pull the corpus from HuggingFace (`elizaos/eliza-toon-v1-sft`) and have the remote `datasets.load_dataset(...)` it directly — no local rsync of 22 GB.

### 3.3 Training matrix (run sequentially in tmux on remote)

| Size | seq_len | epochs | per-rank mem | wall (Blkw6000-2x) | est cost |
|---|---|---|---|---|---|
| Qwen3.5-2B | 4096 | 3 | ~12 GB | ~1.5 h | $2 |
| Qwen3.5-9B | 8192 | 3 | ~28 GB | ~7 h | $9 |
| Qwen3.6-27B | 8192 | 3 | ~64 GB | ~21 h | $28 |

(MFU 30% on Blackwell consumer, 100M tokens budget per epoch on 1.5M examples)

Single tmux session running:
```bash
for size in 2b 9b 27b; do
    REGISTRY_KEY=qwen3.5-$size RUN_NAME=qwen-$size-eliza-v1 \
        bash scripts/train_vast.sh run    # blocks until done
    bash scripts/train_vast.sh quantize   # PolarQuant + TurboQuant + QJL
done
```

### 3.4 Quantize each checkpoint

Already wired: `scripts/quantization/{polarquant,fused_turboquant,qjl}_apply.py`. Run against each `final/` checkpoint, output to `final-{polarquant,fused_turboquant,qjl}/`.

Calibration: 128 samples from `data/final/val.jsonl` (already validated).

---

## 4. Benchmark plan

### 4.1 eliza_bench (action-calling consistency) — already wired

```bash
uv run python scripts/benchmark/eliza_bench.py \
    --model checkpoints/qwen-9b-eliza-v1/final \
    --base-model Qwen/Qwen3.5-9B \
    --test-file data/final/test.jsonl \
    --max-per-bucket 500 \
    --out-dir benchmarks/qwen-9b-eliza-v1/eliza_bench
```

Reports per-bucket:
- `format_ok` — TOON document parses into the expected envelope
- `content_ok` — action name + RESPOND/IGNORE/STOP decision matches expected
- per-task_type breakdown (should_respond / message_handler / reply / claude_distill)

**Acceptance gate**: `format_ok ≥ 95%`, `content_ok ≥ 80%` per bucket. Below that, training failed; investigate.

### 4.2 Agent benchmarks via eliza-adapter

Architecture:
```
benchmark runner → eliza HTTP server → AgentRuntime → vLLM (serving the trained model)
```

The trained model is served via vLLM behind an OpenAI-compatible endpoint. The eliza runtime is configured with `OPENAI_BASE_URL=http://localhost:8000/v1` to talk to it.

Three priority benchmarks (out of 24 registered) targeted by the user:

#### BFCL — Berkeley Function-Calling Leaderboard
The canonical action-calling benchmark. Tests:
- AST accuracy (function name + argument structure)
- Executable accuracy (does the call actually run)
- Relevance accuracy (does the model invoke a tool when needed)

```bash
cd /home/shaw/milady/eliza/packages/benchmarks
python -m bfcl.cli run --provider milady-local \
    --model http://localhost:8000/v1/chat/completions \
    --output bfcl-qwen-9b-eliza-v1.json
```

**Acceptance gate**: BFCL overall ≥ baseline Qwen3.5-9B from the leaderboard. Improvement on `relevance_accuracy` is the headline metric for our planner-envelope training.

#### Tau-bench — multi-turn customer service & retail
Multi-turn agent behavior test. Both `airline` and `retail` domains.

```bash
cd /home/shaw/milady/eliza/packages/benchmarks/tau-bench
python -m tau_bench.run --agent eliza-adapter --user-model gpt-5.5 \
    --task airline --num-trials 50
```

**Acceptance gate**: pass-rate ≥ baseline.

#### AgentBench — cross-domain (OS, DB, KG, web)
Tests breadth of agent capability across 8 domains.

```bash
cd /home/shaw/milady/eliza/packages/benchmarks/agentbench
python -m agentbench.harness --eliza-base-url http://localhost:3000 \
    --tasks os,db,knowledge_graph --num-tasks 20
```

### 4.3 Bench matrix to produce

For each model size × variant (base, fine-tuned-bf16, fine-tuned-PolarQuant, fine-tuned-TurboQuant, fine-tuned-QJL) × benchmark, record:
- score
- format/content split (where applicable)
- generation latency p50/p95
- token throughput

Total cells: 3 sizes × 5 variants × 4 benchmarks = **60 evaluation runs**. ~15 min/run on the same Blkw6000-2x = ~15 hours of bench time.

Output: `benchmarks/<run_name>/<bench_id>.json` with the canonical `BenchmarkResult` schema from `eliza/packages/benchmarks/bench_cli_types.py`.

---

## 5. Verification rigor — what "100% correct" means

### 5.1 Pre-train invariants
- `previews/_full_validate.json` shows 99.9972% TOON validity on the corpus → near-zero adversarial samples leak into training.
- `format_for_training.system_prompt_for(...)` resolves to the registry template → identical conditioning across formatters (Together, Gemini, local).
- `pack_dataset.py` manifest reports per-source dedup and per-task_type distribution → no source dominates.

### 5.2 Train-time invariants
- `training/instrumentation.py` hard-fails when reserved memory exceeds the registry budget × 1.10 — prevents silent OOM-by-fragmentation.
- Save a checkpoint at step 1, decode it via `model.generate()` against a single val record — confirms the FSDP shard reconstructs and the model can produce text.
- Liger fused-CE check: log `outputs.loss` every step. If `outputs.logits is not None` while Liger should be active, abort — it means Liger didn't patch.

### 5.3 Post-train invariants
- Quantization round-trip: every `_apply.py` script writes a `*_report.json` with weight error stats. Reject the variant if MSE rises above a per-quant threshold (`polarquant: 0.02`, `fused_turboquant: 0.05`, `qjl: 0.10`).
- eliza_bench format_ok must not regress vs base model — if format conformance drops, training broke the chat template.
- Generation parity: 10 prompts decoded by full-precision and quantized variants; cosine similarity of logit distributions ≥ 0.98.

### 5.4 Post-bench invariants
- Compare against base model on every benchmark; never publish a result where fine-tuned regresses below base.
- Compare against the canonical leaderboard numbers from each benchmark's paper / website. If our `Qwen3.5-9B` score on BFCL is wildly off the published `Qwen2.5-7B` score, the harness is misconfigured.
- Re-run a 10% sample with `temperature=0` and confirm score within ±2% — confirms benchmark determinism.

---

## 6. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| APOLLO+FSDP `use_orig_params` doesn't work as expected | Med | Spend day-0 on a single training step verification with the 2B model before committing the 9B/27B. |
| Vast instance fails mid-27B run (~20h) | Med-High | Save checkpoints every 500 steps to `/workspace/training/checkpoints/`, rsync after each save. Re-provision and resume if interrupted. |
| Bandwidth is too slow for HF model + dataset download | Low | The 9B downloaded in ~3 min on the smoke instance; 27B in ~7 min. Acceptable. |
| Eliza HTTP server contract drifts vs adapter | Low | Smoke-test the adapter against base Qwen3.5-9B before each fine-tune bench. |
| BFCL provider key required | Low | Use the local-mode flag (no external provider; routes to localhost vLLM endpoint). |

---

## 7. Execution order

**Day 0 (verification, ~$3 spend):**
1. Provision blkw6000-2x.
2. Patch APOLLO + FSDP wiring (use_orig_params + create_optimizer fix).
3. Smoke train 2B for 1 epoch on data/smoke (already prepared, 64 samples).
4. Quantize the 2B checkpoint with all three quant scripts.
5. Run eliza_bench against 2B-base, 2B-fine-tuned, 2B-quant variants.
6. **Gate**: All format_ok scores ≥ 95% on quant variants. If yes, proceed to day 1.

**Day 1 (real training, ~$15 spend):**
1. Train 2B for 3 epochs on full corpus (~1.5 h).
2. Train 9B for 3 epochs (~7 h).

**Day 2 (27B + benchmarks, ~$15 spend):**
1. Train 27B for 3 epochs (~21 h).
2. While 27B trains, run agent benchmarks on 2B and 9B variants in parallel via vLLM endpoints on the same instance (Blackwell6000 has spare capacity since FSDP only uses ~70 GB of 96).
3. After 27B finishes, run bench matrix on it.
4. Fetch all artifacts back, teardown.

**Total estimated cost**: $30-35 on Vast. **Total wall time**: ~60 hours including all benchmarks.

---

## 8. Deliverables

- `checkpoints/{2b,9b,27b}-eliza-v1/final` (bf16 fine-tuned weights, FSDP sharded format)
- `checkpoints/{2b,9b,27b}-eliza-v1/final-{polarquant,fused_turboquant,qjl}` (quantized variants)
- `benchmarks/{2b,9b,27b}-eliza-v1/{eliza_bench,bfcl,tau,agentbench}.json` (60 result files)
- `benchmarks/MATRIX.md` — pivot table of all results
- HF Hub upload of each fine-tuned variant under `elizaos/eliza-1-{2b,9b,27b}` (and sibling `-gguf` / `-fp8` / `-polarquant` / `-turboquant` repos for quant variants).

---

## 9. What we're NOT doing

- **1M context training.** Math says no for a 27B at any reasonable cluster size. 1M is an inference-time target (PolarQuant + QJL + TurboQuant make it fit in 25 GB on a single 48 GB Blackwell, per `memory_calc fit`).
- **MoE training.** Qwen3.6-35B-A3B (3B active params) would actually fit cheaper on Blkw6000-2x, but the user asked for dense 27B. Note for follow-up: the MoE is the better cost/quality tradeoff if total cost matters more than total param count.
- **Multi-node.** Sticking with 2-GPU FSDP. If 27B doesn't converge in 3 epochs we could re-provision blkw6000-4x (still under $50/run total).
