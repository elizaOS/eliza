# RL Training Runbook

Stage 1 (DPO) and Stage 2 (GRPO via verl) for the eliza-1 series. The
strategy and rationale live in [`../RL_STRATEGY.md`](../RL_STRATEGY.md);
this is the operator's "what command do I type" reference.

Both stages produce checkpoints in the same on-disk layout as the SFT loop
(`<output-dir>/final/`) and write the same `instrumentation.jsonl` schema,
so the dashboard plot and the quantization sidecar pipeline consume them
without changes.

## Prerequisites

```bash
# Stage 1 (DPO) needs the train extra (torch + trl + apollo + liger).
uv sync --extra train

# Stage 2 (GRPO) needs the rl extra (verl + vllm rollout server).
# `rl` conflicts with `train` and `serve` on torch ABI — pick the right
# extra per stage rather than trying to combine them.
uv sync --extra rl

# AI-judge reward (optional; off by default).
uv sync --extra reward
export ANTHROPIC_API_KEY=sk-ant-...
export ELIZA_REWARD_USE_AI_JUDGE=1
```

## Smoke the reward function (CPU only)

No GPU required — runs the verifiable scorer on hand-written prompts and
catches regressions in `native_tool_call_bench` integration.

```bash
cd training
pytest -xvs scripts/test_reward_fn.py
```

Standalone CLI for ad-hoc scoring (also what verl's reward server invokes
when you point it at this script as a subprocess):

```bash
python scripts/eliza_reward_fn.py \
    --prompt-jsonl /tmp/prompts.jsonl \
    --responses-jsonl /tmp/responses.jsonl \
    --out /tmp/reward.json
```

## Stage 1 — DPO

Cheap warmup. Reads `data/synthesized/action_pairs/*.jsonl`, treats the
synthesized `expectedResponse` as `chosen`, and synthesizes a corrupted
`rejected` per record (perturbed action label / broken native JSON envelope) so
DPO has a clean preference signal without paying for a teacher rollout.

### Smoke (5 steps, any size, any GPU)

```bash
uv run --extra train python scripts/train_dpo.py \
    --registry-key qwen3.5-2b \
    --sft-checkpoint checkpoints/eliza-1-0_8b-sft/final \
    --output-dir checkpoints/eliza-1-0_8b-dpo-smoke \
    --max-steps 5 --max-samples 64
```

### Real runs

| size | command | hardware | wall time |
|------|---------|----------|-----------|
| 0.8b | `uv run --extra train python scripts/train_dpo.py --registry-key qwen3.5-0.8b --sft-checkpoint checkpoints/eliza-1-0_8b-sft/final --output-dir checkpoints/eliza-1-0_8b-dpo` | 1× consumer 16 GB | ~10 min |
| 2b   | `uv run --extra train python scripts/train_dpo.py --registry-key qwen3.5-2b   --sft-checkpoint checkpoints/eliza-1-2b-sft/final   --output-dir checkpoints/eliza-1-2b-dpo`   | 1× H200 SXM | ~1 h |
| 9b   | `uv run --extra train python scripts/train_dpo.py --registry-key qwen3.5-4b   --sft-checkpoint checkpoints/eliza-1-4b-sft/final   --output-dir checkpoints/eliza-1-4b-dpo`   | 1× H200 SXM | ~5 h |
| 27b  | `uv run --extra train python scripts/train_dpo.py --registry-key qwen3.5-4b  --sft-checkpoint checkpoints/eliza-1-4b-sft/final  --output-dir checkpoints/eliza-1-4b-dpo`  | 2× B200 (FSDP) | ~12 h |

### Knobs

- `--beta 0.1` (default) — DPO temperature. Raise to 0.3-0.5 if the policy
  drifts too far from the SFT reference. The loss curve in
  `instrumentation.jsonl` will show this as a sudden drop in `rewards/margins`.
- `--lr 5e-6` (default) — typically 1/10 of SFT LR. Higher LR destabilizes
  the implicit-RM objective; if loss explodes in the first 50 steps,
  lower it.
- `--epochs 1` (default) — one pass over the pair set. Multi-epoch DPO
  tends to over-fit because the chosen/rejected labels are deterministic.

Output is consumable by the existing quant pipeline:
```bash
python scripts/run_pipeline.py --registry-key qwen3.5-4b \
    --skip-finetune --checkpoint checkpoints/eliza-1-4b-dpo/final
```

### Smoke test

```bash
pytest -xvs scripts/test_dpo_smoke.py
```

Skipped automatically when CUDA or `trl` are missing. Asserts that
`<out>/final/config.json` lands.

## Stage 2 — GRPO (verl)

Real leverage. Generates K rollouts per prompt, scores each with
`scripts/eliza_reward_fn.py:compute_score`, applies group-relative advantage
(GRPO), updates the policy. The verl entrypoint
(`python -m verl.trainer.main_ppo +trainer.algorithm=grpo`) is wrapped by
`train_grpo_verl.sh` which generates the Hydra YAML and launches the
trainer.

### Real runs

| size | command | hardware | wall time |
|------|---------|----------|-----------|
| 2b   | `bash scripts/train_grpo_verl.sh --registry-key qwen3.5-2b   --dpo-checkpoint checkpoints/eliza-1-2b-dpo/final   --output-dir checkpoints/eliza-1-2b-grpo   --rollouts 8 --rollout-batch 8` | 2× H200 (1 train + 1 rollout) | ~24 h |
| 9b   | `bash scripts/train_grpo_verl.sh --registry-key qwen3.5-4b   --dpo-checkpoint checkpoints/eliza-1-4b-dpo/final   --output-dir checkpoints/eliza-1-4b-grpo   --rollouts 8 --rollout-batch 8` | 4× H200 (1 train + 3 rollout) | ~24-48 h |
| 27b  | `bash scripts/train_grpo_verl.sh --registry-key qwen3.5-4b  --dpo-checkpoint checkpoints/eliza-1-4b-dpo/final  --output-dir checkpoints/eliza-1-4b-grpo  --rollouts 8 --rollout-batch 8` | 8× H200 (4 train + 4 rollout) | ~48 h |

### Knobs

- `--rollouts 8` (K) — group size per prompt. DeepSeek's GRPO default.
  Raise to 16 to halve gradient variance at 2× rollout cost.
- `--rollout-batch 8` — prompts per rollout step. Bound by vLLM rollout
  GPU memory, not training; raise until vLLM OOMs.
- `--kl-coef 0.001` — KL penalty vs the DPO reference. If the policy
  collapses to one mode (rewards saturate at the band's max), raise to
  0.01.
- `--max-response-len 1024` — clamp to keep rollouts cheap. Our native JSON
  outputs are <500 tokens 99% of the time; this is a forward-pass cap, not
  a quality cap.

The script writes `<output-dir>/verl_config.yaml` (the Hydra config it
generates) and seeds `<output-dir>/instrumentation.jsonl` with a
`train_begin` event matching the SFT/DPO schema, so the dashboard's plot
pipeline picks up Stage 2 the same way it picks up Stage 0/1.

When verl isn't installed yet, the script writes the YAML and exits 0 with
the install hint — useful for previewing the config on a CPU-only box.

## Pipeline

```
SFT (train_local.py / train_vast.sh)
    └── checkpoints/<run>-sft/final/
        └── DPO (train_dpo.py)               ← Stage 1
            └── checkpoints/<run>-dpo/final/
                └── GRPO (train_grpo_verl.sh) ← Stage 2
                    └── checkpoints/<run>-grpo/final/
                        └── quant pipeline (run_pipeline.py --skip-finetune)
```

Each `final/` is a drop-in for the next stage and for
`scripts/quantization/*.py`. The HuggingFace push uses
`scripts/push_model_to_hf.py --repo-id elizaos/eliza-1-<size>-rl-v1` for
the GRPO output (per RL_STRATEGY.md naming).
