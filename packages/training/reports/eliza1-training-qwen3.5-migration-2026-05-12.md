# Eliza-1 training migration to the Qwen3.5 backbone — 2026-05-12

## Directive

All eliza-1 base models must be **Qwen3.5**, not Qwen3 — Qwen3 dense models
don't run on dflash; eliza-1 is a Qwen3.5 line. Optimizer must be **APOLLO**
(`apollo` / `apollo_mini`) everywhere — never AdamW, never Muon. The prior
H200 SFT run was on the wrong base (`Qwen/Qwen3-0.6B`) — killed, VM torn
down, no GPU training time spent.

## Verified preconditions (this report)

### Published Qwen3.5 repos on HF — all confirmed via `HfApi().model_info`

| repo | downloads |
| --- | --- |
| `Qwen/Qwen3.5-0.8B` / `-Base` | 2.88M / 152k |
| `Qwen/Qwen3.5-2B` / `-Base` | 1.95M / 82k |
| `Qwen/Qwen3.5-4B` / `-Base` | 6.36M / 172k |
| `Qwen/Qwen3.5-9B` / `-Base` | 8.28M / 153k |
| `Qwen/Qwen3.5-27B` | 3.34M |

### Qwen3.5 architecture facts (from each base's `config.json` → `text_config`)

`model_type: qwen3_5`, `architectures: ["Qwen3_5ForConditionalGeneration"]`.
Hybrid: `full_attention_interval=4` → one full-attention (KV-bearing) layer
every 4 layers, the rest Gated-DeltaNet linear-attention layers. Multimodal
(`vision_config` present). Vocab 248320. `max_position_embeddings` 262144.

| base | layers | full-attn | q_heads | kv_heads | head_dim | hidden | intermediate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Qwen3.5-0.8B-Base | 24 | 6 | 8 | 2 | 256 | 1024 | 3584 |
| Qwen3.5-2B-Base | 24 | 6 | 8 | 2 | 256 | 2048 | 6144 |
| Qwen3.5-4B-Base | 32 | 8 | 16 | 4 | 256 | 2560 | 9216 |
| Qwen3.5-9B-Base | 32 | 8 | 16 | 4 | 256 | 4096 | 12288 |
| Qwen3.5-27B | 64 | 16 | 24 | 4 | 256 | 5120 | 17408 |

### qwen3_5 class loads cleanly

`transformers==5.7.0` (in `packages/training/.venv`) has the `qwen3_5`
architecture. `AutoModelForCausalLM.from_pretrained("Qwen/Qwen3.5-0.8B-Base",
dtype=torch.bfloat16)` → `Qwen3_5ForCausalLM`, 0.752B params, 186 2-D
projectable weight matrices (APOLLO's `_split_params` has plenty to project),
320 total tensors. No `trust_remote_code` needed.

Caveat: the linear-attention "fast path" (flash-linear-attention /
causal-conv1d) is not installed, so it falls back to the torch
implementation — works for training, just slower on the SSM layers. Not a
blocker; can install `flash-linear-attention` + `causal-conv1d` on the
training VM for a speedup.

Torch on the local `.venv` is `2.11.0+cu130`; per the prior debugging notes
the Nebius H200 needs `torch 2.11.0+cu128` (cu130 vs the 570.x driver).
`train_nebius.sh` already handles that swap.

### APOLLO-everywhere audit — PASS, no AdamW/Muon to remove

- `scripts/training/optimizer.py` — APOLLO-only. Exposes only
  `build_apollo_optimizer` (full, channel-wise, rank-256, scale-1),
  `build_apollo_mini_optimizer` (rank-1, tensor-wise, scale-128), and their
  FSDP-safe `*_from_groups` variants. fp32 moments are forced under FSDP-bf16
  via `_FP32MomentsAPOLLO` (pre-creates `exp_avg`/`exp_avg_sq` in fp32 before
  upstream's `if "exp_avg" not in state` fires). Only 2-D weights (q/k/v/o,
  gate/up/down) are routed through the low-rank projector; embeddings/lm_head/
  norms/biases stay in the unprojected group. `_build_param_groups` raises if
  there are no 2-D weights to project — no silent fall-through.
- `scripts/train_local.py` — `--optimizer {apollo, apollo_mini}` only,
  default `apollo`; `--qlora` is hard-disabled; auto-enables `--full-finetune`.
- `scripts/train_dpo.py` — same `--optimizer {apollo, apollo_mini}` choices.
- `scripts/run_pipeline.py` — no optimizer arg of its own; pulls from the
  registry entry, which only ever carries `apollo` / `apollo_mini`.
- `scripts/train_nebius.sh` — delegates to `run_pipeline.py` with
  `--registry-key`; no optimizer override path.
- `pytest scripts/training/test_optimizer_cpu.py` — 6 passed (loss-decrease
  tests).

No AdamW / Muon code path is reachable from any training entrypoint. Nothing
to remove.

## Tier lineup

A sibling workstream owns the `model_registry.py` / cloud-script edits and
committed `4b5efe285b feat(training): add eliza-1-0_8b (Qwen3.5-0.8B) tier +
Qwen3.5 DFlash drafter base` mid-migration. Settled lineup is:

- `qwen3.5-0.8b` → `eliza-1-0_8b` (LOCAL; new small default; APOLLO-mini;
  full-param SFT on a 16 GB RTX 5080)
- `qwen3.5-2b` → `eliza-1-2b` (LOCAL; APOLLO-mini; 16 GB GPU)
- `qwen3.5-4b` → `eliza-1-4b` (LOCAL/workstation; APOLLO-mini; ~24 GB)
- `qwen3.5-9b` → `eliza-1-9b` (WORKSTATION; APOLLO full rank-512; 80 GB-class
  or one H200)
- `qwen3.5-27b` → `eliza-1-27b` (+ `27b-256k`/`27b-1m` context variants)
  (CLOUD; APOLLO-mini)

### 27B single-H200 memory math

27B bf16 ≈ 54 GB weights + ≈ 54 GB bf16 grads + APOLLO-mini rank-1 fp32
moments (negligible — rank-1 projection collapses the second-moment state to
per-tensor scalars) + grad-checkpointed activations at seq=32k / mb=1 ≈ fits
inside a 141 GB H200 with headroom. Run as `--tier 27b` on a single H200; if
the per-rank instrumentation trips the budget, fall back to `gpu-h200x2` +
FSDP (~$40-50, needs explicit operator confirmation — do not auto-launch the
2-GPU path).

## Remaining work (owned by the sibling workstream / next agent)

- Decide keep-vs-drop on the legacy Qwen3 `0_6b`/`1_7b`/`4b` registry
  entries (sibling left a `TODO(owner)`; operator's stated preference is
  drop). If dropped, update `model_registry.py`, `test_model_registry.py`,
  `catalog.ts` (`ELIZA_1_TIER_IDS`, `MODEL_CATALOG`, `FIRST_RUN_DEFAULT_MODEL_ID`),
  `eliza-1.manifest.json`, the platform plan, bundle staging, the publish
  pipeline, and all `0_6b`/`1_7b` doc references.
- Set the small-tier registry bases to the `-Base` siblings for SFT
  (`Qwen/Qwen3.5-0.8B-Base`, `Qwen/Qwen3.5-2B-Base`, etc.) — the committed
  entry currently points at the instruct `Qwen/Qwen3.5-0.8B`.
- HF repo renames: `elizaos/eliza-1-0_6b` → `eliza-1-0_8b` (and the
  `-sft`/`-sft-weights`/`-evals` dataset repos). The existing
  `eliza-1-0_6b-sft-weights` is a Qwen3-0.6B test-SFT — keep it but card it
  "old Qwen3-0.6B test-SFT, superseded by the Qwen3.5-0.8B line".
- Re-launch the H200 SFT on `--tier 0_8b` (combined corpus
  `datasets/eliza1-sft-0_6b/` + `data/final/`, `ELIZA1_FULLCORPUS_UPSAMPLE=8`,
  via `scripts/build_eliza1_fullcorpus.py`) with a robust
  `/tmp/nebius-finish-*.sh` watcher (poll `RUN_PIPELINE_EXIT=` →
  `train_nebius.sh fetch` → print `gate_report.json` → `teardown`; plus a
  12h-timeout teardown). No Nebius VM is currently running (`compute instance
  list` → `{}`), so the field is clear.
- Then 2B → 4B → 9B → 27B on the H200 in sequence.
- Local Qwen3.5-0.8B APOLLO SFT on the RTX 5080 as a cross-check — currently
  blocked: a `build-llama-cpp-dflash.mjs --target linux-x64-cuda` build is
  using the 5080 (pids confirmed via `pgrep`). Wait for it to finish.
- The dataset path `datasets/eliza1-sft-0_6b/` is model-agnostic ChatML JSONL
  (chat template applied at train time) — works for any base; renaming the
  directory is optional cosmetic cleanup, not a correctness issue.
