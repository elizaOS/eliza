# Smoke-pipeline audit for the eliza-1 multi-tier sequence — 2026-05-14

> **Scope.** Read-only audit. The user has decided to stop chasing real
> fine-tunes for now and instead validate the **full e2e pipeline**
> (corpus → tokenize → train → eval → quantize → bundle → publish → fetch
> → server-teardown) with ultra-light smoke runs (~10 samples × N
> datasets + recent eliza scenario trajectories) across **every** eliza-1
> tier in sequence on a single Nebius H200. APOLLO mandatory. Auto-fetch
> + auto-teardown mandatory.
>
> Inputs read: `packages/training/scripts/{run_pipeline.py,
> train_local.py,train_nebius.sh,smoke_full_stack.sh,day0_smoke.sh,
> trajectories_to_sft.py,prepare_eliza1_trajectory_dataset.py,
> collect_trajectories.py,build_eliza1_fullcorpus.py,
> normalize.py,pack_dataset.py,training/{model_registry,optimizer}.py,
> cloud/run-on-cloud.sh,nebius_watcher.sh}`,
> `packages/shared/src/local-inference/catalog.ts`,
> `packages/training/reports/eliza1-h200-postmortem-2026-05-12.md`,
> `plugins/plugin-local-inference/native/{AGENTS.md,CLAUDE.md,
> reports/porting/2026-05-12/eliza1-e2e-audit-2026-05-12.md}`,
> `packages/core/src/{runtime/trajectory-recorder.ts,
> features/trajectories/TrajectoriesService.ts,
> services/trajectory-export.ts}`,
> `plugins/app-training/src/core/privacy-filter.ts`,
> `.swarm/STATUS.md`.

---

## Section 1 — Model inventory per eliza-1 tier

The canonical tier set lives in
`packages/shared/src/local-inference/catalog.ts:20-28` —
`ELIZA_1_TIER_IDS = ["eliza-1-0_8b","eliza-1-2b","eliza-1-4b",
"eliza-1-9b","eliza-1-27b","eliza-1-27b-256k","eliza-1-27b-1m"]`.
`FIRST_RUN_DEFAULT_MODEL_ID = "eliza-1-2b"`
(`catalog.ts:35`).

Per-tier component spec is in `catalog.ts::TIER_SPECS`
(`catalog.ts:166-290`) and
`sourceModelForTier` (`catalog.ts:337-361`). Voice backend per tier:
`ELIZA_1_VOICE_BACKENDS` (`catalog.ts:127-138`) — `0_8b`/`2b`/`4b`
ship **Kokoro only**, `9b` ships both with Kokoro first,
`27b`/`27b-256k`/`27b-1m` ship OmniVoice only.

Asset sources (frozen in `elizaos/eliza-1-assets`):
- ASR: `ggml-org/Qwen3-ASR-0.6B-GGUF` (≤9b) or
  `ggml-org/Qwen3-ASR-1.7B-GGUF` (27b tiers) — bundle path
  `asr/eliza-1-asr.gguf` (`catalog.ts:342`).
- VAD: Silero VAD v5.1.2 — bundle path
  `vad/silero-vad-v5.1.2.ggml.bin` (`catalog.ts:343`); the spec
  brief asks about `.gguf` but the shipped artifact is a **`.ggml.bin`**
  binary (and an optional `vad/silero-vad-int8.onnx` fallback per
  `eliza1_platform_plan.py::optional_files`). Confirmed by the
  2026-05-12 e2e audit §3.7.
- Embedding (1.7b+): `Qwen/Qwen3-Embedding-0.6B-GGUF` — bundle path
  `embedding/eliza-1-embedding.gguf` (`catalog.ts:349-351`). `0_8b`
  pools from the text backbone (no separate embedding GGUF, per
  `TIER_SPECS` — no `hasEmbedding` on `eliza-1-0_8b`).
- Voice (Kokoro): `tts/kokoro/model_q4.onnx` (`catalog.ts:334`).
- Voice (OmniVoice): `tts/omnivoice-base-Q4_K_M.gguf` (small tiers)
  or `tts/omnivoice-base-Q8_0.gguf` (27b tiers) per
  `voiceQuantForTier` (`catalog.ts:323-327`).
- Wakeword: shipped `hey-eliza.onnx` is a renamed
  `hey_jarvis` placeholder; head-plan in
  `plugins/plugin-local-inference/native/reports/porting/2026-05-11/wakeword-head-plan.md`
  (referenced by the 2026-05-12 audit §3.8). Trainer at
  `packages/training/scripts/wakeword/train_eliza1_wakeword_head.py`.
- Vision (mmproj): `vision/mmproj-<slug>.gguf`
  (`catalog.ts:354-357`). All tiers have `hasVision: true` per the
  TIER_SPECS — including `0_8b` since WS2 (`catalog.ts:184`).

### 1.1 Per-tier matrix

Columns: `tier | component | base_id | weights_state | quant |
llamacpp_integrated | fused_binary | apollo_eligible`.

| tier | component | base_id (HF) | weights_state | quant | llamacpp_integrated | fused_binary | apollo_eligible |
|---|---|---|---|---|---|---|---|
| 0_8b | text | `Qwen/Qwen3.5-0.8B-Base` (`model_registry.py:293`) | SFT IN-FLIGHT then crashed @ step ~1000 ckpt local (`.swarm/STATUS.md` v4) | Q4_K_M body planned (PolarQuant deferred) | yes (fork `elizaOS/llama.cpp` `v1.1.0-eliza`) | yes (`linux-x64-cpu-fused`, `linux-x64-cuda-fused`, `linux-x64-vulkan-fused`) | YES (`apollo_mini` rank-1; registry default) |
| 0_8b | drafter | none (smallest tier, no DFlash) | n/a | n/a | n/a | n/a | n/a |
| 0_8b | ASR | `ggml-org/Qwen3-ASR-0.6B-GGUF` (`catalog.ts:342`) | real bytes (frozen in `eliza-1-assets`) | upstream (Qwen3 vocab 151,936) | yes (fork) | yes (fused-HTTP route) | n/a |
| 0_8b | TTS | Kokoro `tts/kokoro/model_q4.onnx` | real bytes | onnx int8 | onnxruntime — not llama.cpp | no | n/a |
| 0_8b | Embedding | none — pools from text backbone (no `hasEmbedding` in `TIER_SPECS`) | n/a | n/a | n/a | n/a | n/a |
| 0_8b | VAD | Silero v5.1.2 (`vad/silero-vad-v5.1.2.ggml.bin`; `.onnx` optional) | real bytes | ggml native (+ onnx fallback) | yes | yes | n/a |
| 0_8b | Wakeword | OpenWakeWord head (`hey-eliza.onnx`) | **STUB** (renamed `hey_jarvis`) | onnx | onnxruntime | no | n/a |
| 0_8b | mmproj | `vision/mmproj-0_8b.gguf` (~220 MB Q4_K_M per ELIZA_1_BUNDLE_EXTRAS) | scaffolded; not produced from a Qwen3.5-VL projector run | Q4_K_M | yes | yes | n/a |
| 2b | text | `Qwen/Qwen3.5-2B-Base` (`model_registry.py:321`) | NO SFT YET; registry only | Q4_K_M | yes | yes | YES (`apollo_mini` rank-1) |
| 2b | drafter | `Qwen/Qwen3.5-0.8B-Base` distilled to ~0.6B Qwen3.5-arch | scaffold repo only; no GGUF | Q4_K_M planned | yes | yes | YES (KD via `distill_dflash_drafter.py`) |
| 2b | ASR/TTS/Embedding/VAD/mmproj | same as 0_8b family; +`hasEmbedding:true` (`catalog.ts:198`) | same as 0_8b | same | same | same | n/a |
| 2b | Wakeword | same OpenWakeWord stub | STUB | onnx | onnxruntime | no | n/a |
| 4b | text | `Qwen/Qwen3.5-4B-Base` (`model_registry.py:342`) | NO SFT YET; registry only | Q4_K_M | yes | yes | YES (`apollo_mini` rank-1) |
| 4b | drafter | `Qwen/Qwen3.5-0.8B-Base` → ~0.8B student | scaffold only | Q4_K_M planned | yes | yes | YES |
| 4b | embedding/asr/tts/vad/mmproj/wake | same family pattern | same | same | same | same | n/a |
| 9b | text | `Qwen/Qwen3.5-9B` (`model_registry.py:365`) | no SFT yet | Q4_K_M | yes | yes | YES (`apollo` rank-512) |
| 9b | drafter | Qwen3.5-0.8B-Base → ~2B student | scaffold; no GGUF | Q4_K_M planned | yes | yes | YES |
| 9b | TTS | Kokoro first; OmniVoice second per `ELIZA_1_VOICE_BACKENDS[eliza-1-9b]` | real bytes | mixed (onnx + GGUF Q4_K_M) | yes (OmniVoice fused) | yes | n/a |
| 9b | ASR | `Qwen3-ASR-0.6B-GGUF` | real | Q4_K_M | yes | yes | n/a |
| 9b | Embedding | `Qwen/Qwen3-Embedding-0.6B-GGUF` | real | Q4_K_M | yes | yes | n/a |
| 9b | mmproj | `vision/mmproj-9b.gguf` | scaffold | Q4_K_M | yes | yes | n/a |
| 9b | VAD/Wake | same family pattern (Wake STUB) | same | same | same | same | n/a |
| 27b | text | `Qwen/Qwen3.6-27B` (`model_registry.py:407`); legacy `qwen3.5-27b` resolver retained (`model_registry.py:386`) | no SFT yet (cloud-only) | Q4_K_M (Q8_0 body for TTS only) | yes | yes (`linux-x64-cuda-fused` on H200 class) | YES (`apollo_mini` rank-512) |
| 27b | drafter | Qwen3.5-0.8B-Base → ~4B student | scaffold | Q4_K_M planned | yes | yes | YES |
| 27b | TTS | OmniVoice Q8_0 (`voiceQuantForTier`, `catalog.ts:323-327`) | real bytes | Q8_0 GGUF | yes (fused) | yes | n/a |
| 27b | ASR | `Qwen3-ASR-1.7B-GGUF` (`eliza1-e2e-audit-2026-05-12.md:163`) | real | Q4_K_M | yes | yes | n/a |
| 27b | Embedding | `Qwen3-Embedding-0.6B-GGUF` | real | Q4_K_M | yes | yes | n/a |
| 27b | mmproj | `vision/mmproj-27b.gguf` (~720 MB Q8_0) | scaffold | Q8_0 | yes | yes | n/a |
| 27b | VAD/Wake | same family pattern (Wake STUB) | same | same | same | same | n/a |
| 27b-256k | text | **same backbone** as 27b (`qwen3.6-27b`); registry has NO separate entry — long-context is a quant/runtime variant, not a separate SFT | no SFT yet | Q4_K_M body @ 256k ctx | yes | yes | YES (same as 27b) |
| 27b-256k | all other components | same as 27b family pattern; vision retained (`catalog.ts:267`) | same | same | same | same | same |
| 27b-1m | text | **same backbone** as 27b (`qwen3.6-27b`); no separate registry entry | no SFT yet | Q4_K_M body @ 1M ctx | yes | yes | YES |
| 27b-1m | all other components | same as 27b family; vision retained for server/workstation use (`catalog.ts:288`) | same | same | same | same | same |

**Key gap that the brief over-specifies:** the brief asks per-tier text
models for `27b-256k` and `27b-1m`. In the codebase, those are the
**same `qwen3.6-27b` SFT** quantized at a different KV/context
configuration — they do **not** have separate `model_registry.py`
entries (`packages/training/scripts/training/model_registry.py:407-433`
is the only 27b entry; the legacy `qwen3.5-27b` at line 386 is a
resolver-only alias). The smoke pipeline therefore only needs to run
SFT on 5 backbones (`qwen3.5-0.8b`, `qwen3.5-2b`, `qwen3.5-4b`,
`qwen3.5-9b`, `qwen3.6-27b`) and then re-quantize the 27b checkpoint
three times (`27b` @ 128k, `27b-256k` @ 256k, `27b-1m` @ 1M) for the
last three tiers.

---

## Section 2 — Pipeline state

### 2.1 `run_pipeline.py` stages

The orchestrator is `packages/training/scripts/run_pipeline.py:1-822`.
Stages, as the script declares them (`run_pipeline.py:3-22`):

| # | Stage | Trigger | Artifact → location | Code |
|---|---|---|---|---|
| 0 | From-scratch corpus build | `--from-scratch` | `data/final/{train,val,test}.jsonl` | `run_pipeline.py:411-471` |
| 1 | Pre-train benchmark | not `--skip-base-bench` AND not `--skip-bench` | `benchmarks/<run>/base/native_tool_call/summary.json` | `run_pipeline.py:530-535` |
| 2 | APOLLO SFT (full-parameter) | not `--skip-finetune` | `checkpoints/<run>/final/` | `run_pipeline.py:537-578`, dispatches `train_local.py` |
| 3 | Post-train benchmark | not `--skip-bench` | `benchmarks/<run>/finetuned/native_tool_call/summary.json` | `run_pipeline.py:580-583` |
| 4 | Aggregate evals + gate report | always (after stage 3) | `checkpoints/<run>/evals/aggregate.json`, `checkpoints/<run>/gate_report.json` | `run_pipeline.py:585-637` |
| 5 | Quantize (PolarQuant / fused-TurboQuant / QJL) | not `--skip-quantize` | `checkpoints/<run>/final-<q>/` | `run_pipeline.py:649-666` |
| 6 | Quantized benchmarks | not `--skip-bench` | `benchmarks/<run>/<q>/` | `run_pipeline.py:668-674` |
| 6b | Eliza-1 GGUF bundle | `--eliza1-bundle` (auto-on iff fork found) | `checkpoints/<run>/eliza1-optimized/{Q4_POLAR.gguf,qjl_config.json,turboquant.json,eliza1_manifest.json}` + optional `checkpoints/<run>/dflash/drafter-<tier>.gguf` | `run_pipeline.py:684-733` |
| 6c | Throughput bench (llama-bench) | not `--skip-throughput-bench` | `checkpoints/<run>/evals/throughput.json` | `run_pipeline.py:741-771` |
| 7 | Publish | `--publish` (with `--bundle-dir`) AND gate green | HF push via `scripts.publish.orchestrator` | `run_pipeline.py:773-810` |

`pipeline-summary.json` is written under `benchmarks/<run>/` after every stage
(`run_pipeline.py:436-437`, `:813`).

Note: stage 0 + stage 0.5 (corpus validation) run **before** stage 2 —
`validate_corpus.py --strict` is enforced on `train/val/test.jsonl`
before training (`run_pipeline.py:486-516`); the only escape is
`--allow-unvalidated-corpus`.

### 2.2 `train_local.py`

`train_local.py:217-712`. It is APOLLO-only by hardcoded contract:

- `args.optimizer in (apollo, apollo_mini)` is the only allowed choice
  (`train_local.py:262-267`). The choices list literally is
  `["apollo", "apollo_mini"]`.
- `ELIZA_TRAINER_OPTIM` env is **rejected at runtime**
  (`train_local.py:506-510`) — there is no path for AdamW/Muon/LoRA.
- Optimizer is built via `_ElizaSFTTrainer.create_optimizer`
  (`train_local.py:633-651`) which calls `apollo_builder` returning
  `build_apollo_optimizer_from_groups` / `build_apollo_mini_optimizer_from_groups`.
- PyTorch 2.6+ `weights_only=True` resume issue: **already patched**
  (`train_local.py:367-385`). `add_safe_globals([GradientProjector])`
  is registered when `--resume-from-checkpoint` is set. **The brief
  states "v5 just failed because PyTorch 2.6+ weights_only=True default
  rejects APOLLO GradientProjector from optimizer.pt"** — the source-side
  fix has landed; v5 must use a build where this `train_local.py` is
  the active version. Confirm with a `git log -- packages/training/scripts/train_local.py`
  spot-check before launching.

### 2.3 `train_nebius.sh` — provision / run / fetch / teardown

`packages/training/scripts/train_nebius.sh:1-634`.

- **Provision**: `train_nebius.sh:228` — `nebius compute v1 instance create
  --parent-id ... --resources-platform gpu-h200-sxm --resources-preset
  1gpu-16vcpu-200gb` (or `8gpu-128vcpu-1600gb` for `gpu-h200x2`). Boot
  disk created in `provision` step; image
  `mk8s-worker-node-v-1-31-ubuntu24.04-cuda12.8` (driver 570.x + CUDA
  12.8 preinstalled).
- **Sync**: `sync_tree` (`train_nebius.sh:275-310`) `rsync -avhz
  --delete` of the local `packages/training/` plus corpus tree.
- **Run**: `run_remote` (`train_nebius.sh:355-441`). Wraps
  `run_pipeline.py` with `--epochs 1 --lr 1e-5 --use-liger on
  --eval-mode full --bench-per-bucket 200 --skip-throughput-bench
  --quantizers $QUANTIZE_AFTER --eliza1-bundle` (`train_nebius.sh:430-436`).
  `MAX_STEPS=N` env → `--max-steps N` flag (already plumbed,
  `train_nebius.sh:364-365`).
- **Fetch (end-only)**: `fetch` (`train_nebius.sh:473-480`). Pulls
  `$REMOTE_TRAIN_DIR/checkpoints/$RUN_NAME/`,
  `$REMOTE_TRAIN_DIR/benchmarks/$RUN_NAME/`, and
  `$REMOTE_TRAIN_DIR/reports/`. **Runs once at the end of the `full`
  flow** — not incrementally. The repo does have
  `packages/training/scripts/checkpoint_sync_loop.sh:2-220` for
  incremental sync, but it polls a Vast.ai instance, not a Nebius VM
  — there is no Nebius-flavored incremental fetcher today.
- **Teardown**: `teardown` (`train_nebius.sh:561-578`) — `nebius
  compute v1 instance delete` then `nebius compute v1 disk delete`.
  Both swallow non-zero exits with a WARN log.
- **EXIT trap on `full`**: `train_nebius.sh:608-619`:
  ```sh
  trap 'echo "...full: ensuring fetch + teardown on exit"; fetch || true; teardown || true' EXIT
  provision; sync_tree; run_remote; fetch
  ```
  The trap fires `fetch || true; teardown || true` on **every exit**.
  This means:
  - On success (`run_remote` returns 0): main body runs `fetch` once,
    then trap runs `fetch` again (cheap rsync no-op on already-synced
    files) followed by `teardown`. Trap fires cleanly.
  - On failure (`run_remote` returns 1, e.g. 12h wall-cap or
    `set -euo pipefail` propagating an inner crash): main body aborts
    before its own `fetch` line, **trap still runs `fetch` first**
    (this is the key 003d441c7b fix from the v4 incident; before it,
    a failed run skipped fetch entirely). Then teardown runs.
  - On expired nebius CLI auth (v4 issue): `teardown` calls
    `instance_id_by_name` → `nebius compute v1 instance list` →
    hangs / errors. The `|| true` swallows the hang. **In practice,
    the v4 hang was an indefinite stall**, not an immediate non-zero
    exit, so the trap stayed blocked until manual `kill`. This is a
    real risk for the smoke sequence wrapper (see §6).

---

## Section 3 — APOLLO mandate audit

### 3.1 Active training paths

- `train_local.py` (the only local SFT path): APOLLO/APOLLO-Mini only.
  Hardcoded as the only `--optimizer` choices (`train_local.py:262-267`)
  and the only `create_optimizer` builder (`train_local.py:633-651`).
- `train_local.py:506-510` rejects any `ELIZA_TRAINER_OPTIM` env var
  at startup with `SystemExit` — there is no escape hatch.
- `run_pipeline.py` is a thin wrapper around `train_local.py`
  (`run_pipeline.py:548-572`) — it cannot inject a different optimizer
  because the inner script doesn't accept one.

### 3.2 Registry defaults (`model_registry.py`)

Every published-tier entry sets `optimizer="apollo"` or
`optimizer="apollo_mini"`:

| key | tier | optimizer | rank | line |
|---|---|---|---|---|
| qwen3.5-0.8b | LOCAL | apollo_mini | 1 | `model_registry.py:293` |
| qwen3.5-2b | LOCAL | apollo_mini | 1 | `model_registry.py:326` |
| qwen3.5-4b | LOCAL | apollo_mini | 1 | `model_registry.py:347` |
| qwen3.5-9b | WORKSTATION | apollo | 512 | `model_registry.py:370` |
| qwen3.5-27b (legacy) | CLOUD | apollo_mini | 1 | `model_registry.py:392` |
| qwen3.6-27b | CLOUD | apollo_mini | 512 | `model_registry.py:417` |

**No entry defaults to anything other than APOLLO.** The 9B is the
only one using full APOLLO (rank-512) per the paper's recipe; the rest
use APOLLO-Mini.

### 3.3 AdamW / Muon / LoRA / peft references

Grep results across `packages/training/scripts/` (all Python sources):

- **AdamW**: 4 hits in `train_local.py`/`optimizer.py` — all referring
  to `apollo_torch.APOLLOAdamW` (the underlying APOLLO impl extends
  AdamW). Plus `model_registry.py:149` is the comment **forbidding**
  AdamW swaps. `dflash/nebius/distill_drafter_h200.py:40` says "Do
  not replace APOLLO with AdamW or SGD" and uses `APOLLOAdamW` itself
  (`distill_drafter_h200.py:138, :616`). One historical mention in
  `training/test_optimizer_cpu.py:105` — a test comment, not active.
- **Muon**: 1 hit, `model_registry.py:149` — only in the prohibition
  comment. No active path uses Muon.
- **LoRA / peft**: 7 hits in `packages/training/scripts/training/abliterate.py:4,
  :284-285, :321, :337` — `abliterate.py` is the **post-SFT
  abliteration** step (uncensoring), not training. It is not the
  Eliza-1 SFT path and runs separately. Other LoRA hits are in
  `scripts/kokoro/` (Kokoro TTS LoRA finetune), `scripts/quantization/`
  (commentary), and `scripts/push_model_to_hf.py` (peft import
  checks). **None are in the active SFT path.**

### 3.4 `pyproject.toml` / `--extra train`

The `train_local.py` startup imports `apollo_torch` lazily inside
`build_apollo_optimizer` (`optimizer.py:140`). The smoke-runner
`smoke_full_stack.sh:90-108` explicitly checks
`apollo_torch / liger_kernel / turboquant / vllm / transformers` and
fails closed if any is missing — `apollo_torch` is in the `train`
extra and is mandatory.

**Verdict: APOLLO is unambiguous and complete. No non-APOLLO escape
hatch survives in the active training entrypoints.** The only
documentation-level rule the audit confirms is that `model_registry.py:149`
explicitly forbids future swaps to AdamW/Muon.

---

## Section 4 — Smoke-mode gap analysis

### 4.1 What "smoke" means today

Several layers:

1. **Corpus build**: `run_pipeline.py:308 --sample-per-source N`
   passes through to `normalize.py:208` and `pack_dataset.py:332`.
   `pack_dataset.py:336 --smoke` is auto-set when
   `--sample-per-source > 0` (`run_pipeline.py:432-434`). This produces
   `data/final/{train,val,test}.jsonl` capped at ~N records per upstream
   source.
2. **Training**: `train_local.py:74 --max-samples N` caps total training
   records; `train_local.py:80 --max-steps N` (added 2026-05-13 per the
   v5 patch in `003d441c7b`) caps Trainer steps directly. `run_pipeline.py:206-212`
   forwards `--max-steps`. The smoke-test pattern is
   `--max-samples 200 --grad-accum 1 --epochs 1` (~200 optimizer
   steps) per `smoke_full_stack.sh:115-140`.
3. **Bench**: `--bench-per-bucket 10` (smoke) vs `200` (full)
   (`smoke_full_stack.sh:61`, `train_nebius.sh:434`).
4. **Eval mode**: `--eval-mode smoke` writes a structural-gate-only
   `aggregate.json` (`run_pipeline.py:303-310`).

### 4.2 "10 samples per source" path — already exists

`scripts/normalize.py --sample-per-source 10` + `scripts/pack_dataset.py
--smoke --sample-per-source 10` already gives ~10 records per upstream
source. **Caveat**: `build_eliza1_fullcorpus.py:40` (the script
`train_nebius.sh:425` invokes when `SYNC_FULLCORPUS_SOURCES=1`) only
honors `ELIZA1_FULLCORPUS_UPSAMPLE`; there is **no
`--sample-per-source` flag** on the fullcorpus builder. For a smoke
mix that includes both the benchmark-aligned slice and the broad
data/final mix, you must EITHER run the standard `run_pipeline.py
--from-scratch --sample-per-source 10` flow (broad mix, no
benchmark-aligned slice) OR add a `--sample-per-source` flag to
`build_eliza1_fullcorpus.py` (small patch — read its first N lines per
source file rather than all).

### 4.3 Recent eliza scenario trajectories — feasibility

Yes: `prepare_eliza1_trajectory_dataset.py:1488-1528` accepts
`--input <file|dir>` and produces the
`eliza_native_v1`/`eliza.eliza1_trajectory_record.v1` splits the
pipeline understands. `trajectories_to_sft.py:186-198` is the
faster path. Both apply the **mandatory privacy filter**
(`prepare_eliza1_trajectory_dataset.py:75-94`).

### 4.4 Per-tier smoke-run command — what works today

A one-tier smoke command works **today**:

```sh
cd packages/training
REGISTRY_KEY=qwen3.5-0.8b bash scripts/smoke_full_stack.sh
```

This builds a ~200-step APOLLO SFT, quantizes, benchmarks. Wall-clock
on the H200 SXM 1xGPU: ~15–25 min (the script is shaped for an RTX
4090/5090/H100 box; an H200 is ~1.5× faster). **Limitations vs the
brief:**

- It runs against `data/smoke/{train,val}.jsonl` (a pre-built smoke
  split assumed on disk — NOT auto-rebuilt from 10-per-source-with-trajectories).
  Operator must seed those splits or it fails.
- It calls `train_local.py` directly, not `run_pipeline.py` — so the
  stage-4 `aggregate.json` / `gate_report.json` are NOT produced.
- It doesn't run the Eliza-1 GGUF bundle stage (6b).

### 4.5 What's missing for the brief

To meet "10 samples per dataset + recent trajectories → SFT → eval →
quantize → bundle → publish in under 1 hour" the missing pieces are:

1. **A wrapper script** that, per tier:
   - Builds the smoke corpus: `python scripts/build_eliza1_smoke_mix.py
     --sample-per-source 10 --include-recent-trajectories <db-export>`
     (this script does NOT exist; needs to be authored — see
     §7 below).
   - Calls `run_pipeline.py --registry-key <tier> --from-scratch
     --sample-per-source 10 --epochs 0.01 --max-steps 50
     --bench-per-bucket 10 --eval-mode smoke --eliza1-bundle`.
   - Optionally publishes with `--publish --bundle-dir <run>/eliza1-optimized`
     to a tier-specific HF candidate repo.
2. **A trajectory exporter** that pulls "recent N days" + "scenario only"
   from the trajectories table. `TrajectoriesService.listTrajectories`
   already supports `{startDate, scenarioId, source}` filters
   (`TrajectoriesService.ts:2111-2172`). A CLI or HTTP route to
   stream those to JSONL is missing — see §5.
3. **A multi-tier orchestrator** for sequential runs on the same VM with
   per-tier fetch and final teardown — see §6.

### 4.6 Per-tier wall-clock estimate (H200 SXM 1xGPU, 16 vCPU, 200 GB RAM)

Assumptions:
- Smoke corpus = ~10 records × ~80 sources (per `data/raw` directory
  listing — see `download_datasets.py`) ≈ 800 train records + ~80
  val + ~80 test.
- 50 SFT steps at the registry's micro-batch × grad-accum (`mb=1
  ga=8` for 0.8b/2b/4b; `mb=2 ga=8` for 9b; `mb=1 ga=8` for 27b).
- Liger fused chunked-CE on, bf16, `--lr 1e-5`.
- Throughput proxy from `.swarm/STATUS.md` v4: ~25 s/iter on H200
  for 0.8b at 4k seq_len. Larger tiers scale ~linearly with params.

| tier | corpus build | model load | 50 SFT steps | eval + bench | quant + bundle | total |
|---|---|---|---|---|---|---|
| 0_8b | 2 min | 1 min | 50 × 25 s = ~21 min | 2 min | 5 min | **~31 min** |
| 2b | 2 min | 2 min | 50 × 35 s = ~29 min | 2 min | 6 min | **~41 min** |
| 4b | 2 min | 3 min | 50 × 55 s = ~46 min | 3 min | 8 min | **~62 min** |
| 9b | 2 min | 5 min | 50 × 110 s = ~92 min | 4 min | 12 min | **~115 min** |
| 27b (Q3.6-27B, single H200, `apollo_mini` rank-512) | 2 min | 8 min | 50 × 320 s = ~267 min — **DOES NOT FIT**: per the 27b note in `train_nebius.sh:21-25`, 27b on Nebius needs `gpu-h200x2` (8×H200) | — | — | **N/A on 1×H200** |
| 27b-256k | (same backbone as 27b — long-context re-quant only) | — | n/a | — | 10 min | **~10 min** (post-27b) |
| 27b-1m | (same backbone) | — | n/a | — | 12 min | **~12 min** (post-27b) |

**Brutal honest summary**: the smoke sequence fits on a **single
1×H200** only for `0_8b → 2b → 4b → 9b` (sum ≈ 4 h). The 27b SFT
genuinely needs `gpu-h200x2` (8×H200), which violates "single H200"
in the brief. Two viable paths:

- **(A)** Run 27b SFT on a separate Vast.ai box (any 2× or 4× H200/B200)
  and only the post-quant for `27b`/`27b-256k`/`27b-1m` on the same
  Nebius 1×H200 (a no-train re-quant pass on the published `eliza-1-27b`
  HF candidate — uses `run_pipeline.py --skip-finetune --skip-base-bench`).
- **(B)** Accept that the 27b row "passes smoke" via "ingest published
  HF Q4_K_M bytes, run Eliza-quant on top, run 6c throughput-bench"
  and skip SFT — the pipeline supports this via
  `--skip-finetune --skip-base-bench`.

For the brief's "single H200, full sequence" framing, **(B)** is
the right call. Total wall-clock estimate under (B):

| step | time |
|---|---|
| 0_8b smoke SFT+pipeline | 31 min |
| 2b smoke SFT+pipeline | 41 min |
| 4b smoke SFT+pipeline | 62 min |
| 9b smoke SFT+pipeline | 115 min |
| 27b skip-finetune, re-quant + bundle | 15 min |
| 27b-256k re-quant + bundle (long ctx) | 10 min |
| 27b-1m re-quant + bundle (long ctx) | 12 min |
| **total (sequential, single 1×H200)** | **~4h 46m** |

Add provisioning (~3 min), code rsync (~2 min), teardown (~1 min) for
a **~4h 52m end-to-end on a single 1×H200**. Comfortable margin under
the 12h `ELIZA_REMOTE_RUN_TIMEOUT_H` watcher cap.

---

## Section 5 — Recent eliza scenario trajectories — provenance

### 5.1 Schema

`packages/core/src/features/trajectories/TrajectoriesService.ts:1083-1115`
defines the `trajectories` table (Postgres / PGlite). Columns relevant
to filter-by-recent-scenarios:

- `created_at TIMESTAMPTZ` (`TrajectoriesService.ts:1113`).
- `scenario_id TEXT` (`TrajectoriesService.ts:1099`).
- `source TEXT` (`TrajectoriesService.ts:1086` — values include `chat`,
  scenario sources defined by `collect_trajectories.py:54-56`:
  `live-scenarios`, `scenario-benchmark`, `scenario-runner`).
- `status TEXT`, `is_training_data BOOLEAN`, `is_evaluation BOOLEAN`,
  `used_in_training BOOLEAN` — useful for distinguishing
  unjudged-live vs reviewed-training rows.
- Indexes on `agent_id`, `source`, `status`, `created_at`, `scenario_id`
  (`TrajectoriesService.ts:1122-1140`).

### 5.2 DB location

- **Default**: managed by the runtime's `adapter` (PGlite when running
  local Milady; full Postgres for Eliza Cloud). The recorder also
  writes a JSON-per-trajectory mirror to
  `${ELIZA_TRAJECTORY_DIR ?? ELIZA_STATE_DIR/trajectories ??
  MILADY_STATE_DIR/trajectories ?? ~/.eliza/trajectories}` per
  `trajectory-recorder.ts:355-372`.
- **Per repo `CLAUDE.md`**: the canonical state root for this repo is
  `~/.milady/trajectories/` (set via `ELIZA_STATE_DIR=~/.milady`).

### 5.3 Export script status

There is **no single, ready-to-run "recent-N-days, scenario-only"
exporter**. The pieces:

- `TrajectoriesService.listTrajectories({startDate, scenarioId,
  source})` already supports the right filters
  (`TrajectoriesService.ts:2129-2156`).
- `trajectory-export.ts` (`packages/core/src/services/trajectory-export.ts:1-...`)
  is the canonical exporter and the source-of-truth for the
  `eliza_native_v1` JSONL shape that `trajectories_to_sft.py:198-237`
  consumes.
- There is no CLI script under `packages/training/scripts/` that
  invokes `listTrajectories` with a date filter and dumps JSONL
  (the closest is `prepare_eliza1_trajectory_dataset.py`, but it reads
  pre-exported files, not live DB rows).
- The HTTP route `/api/training/trajectories/export` exists (per
  `plugins/app-training/src/setup-routes.ts`) but the per-call query
  options I could verify in this audit window are `runId`/`scenarioId`
  not `days`/`since`. Adding a `--days N` flag to the export route is
  a small TypeScript patch; adding a `collect_recent_scenarios.mjs`
  CLI that calls the same function and writes JSONL is the
  zero-DB-coupling alternative.

### 5.4 Privacy filter

`plugins/app-training/src/core/privacy-filter.ts` and the duplicate
Python port in
`packages/training/scripts/privacy_filter_trajectories.py`. Both detect
+ redact / anonymize:

- API keys (per `prepare_eliza1_trajectory_dataset.py:97-100`:
  `sk-`/`sk-ant-`/`AIza...` etc.).
- Phone numbers, email addresses, SSN-shape, credit-card-shape patterns.
- Counters tracked in `FilterStats.{redaction_count,
  anonymization_count, credential_hits}` —
  `prepare_eliza1_trajectory_dataset.py:90-93`.

Application points:

- `prepare_eliza1_trajectory_dataset.py:75-94` — every record on the
  on-demand SFT path (the active training orchestrator).
- `plugins/app-training/src/...` nightly export cron — every record
  written to the export JSONL.

Per repo `CLAUDE.md`: "The privacy filter (`eliza/plugins/app-training/src/core/privacy-filter.ts`)
is mandatory on every write path that touches real user trajectories
— both the nightly export cron and the on-demand training orchestrator
run it before any JSONL is written." Audit confirms both paths apply
it; **smoke-corpus mixing must continue to route trajectories through
this filter** (do not bypass for synthetic / "internal only" smoke).

### 5.5 Minimum work to build the "recent N days, scenario-only" path

Three options, ordered by effort:

1. **Easiest (~30 min)**: a thin Python CLI
   `scripts/collect_recent_trajectories.py --db ~/.milady/trajectories.pglite
   --since 7d --source scenario-runner --out /tmp/recent-scen.jsonl`
   that imports the existing PGlite reader, applies the listTrajectories
   filter (date+source), and serializes each row through
   `trajectory-export.ts::serializeTrajectory()`. Then pass
   `--trajectory-export /tmp/recent-scen.jsonl` to `run_pipeline.py`
   (the flag is at `run_pipeline.py:241-249`).
2. **Slightly more (~1h)**: extend `prepare_eliza1_trajectory_dataset.py`
   with `--since-days N --source-allowlist scenario-runner,scenario-benchmark`
   args that filter input rows in-process. Keeps the existing
   privacy-filter routing.
3. **Most invasive (~2h)**: add `/api/training/trajectories/export?days=N&source=...`
   to `plugins/app-training/src/setup-routes.ts`, wire `runFineTuning`
   to call it. Requires a running runtime; useful for ongoing training
   rather than the one-shot smoke.

**Recommendation: option (1).** The smoke pipeline does not need a
running runtime; it just needs the JSONL.

---

## Section 6 — Auto-teardown design recommendation

### 6.1 Today's EXIT trap walk-through

`train_nebius.sh:608-619` (post-`003d441c7b`):

```sh
full)
  trap 'echo "[train_nebius] full: ensuring fetch + teardown on exit"; fetch || true; teardown || true' EXIT
  provision
  sync_tree
  run_remote
  fetch
  ;;
```

Cases:

- **Success path**: `provision → sync_tree → run_remote (exits 0) →
  fetch` (main-body fetch runs, pulls real artifacts). Trap fires on
  normal exit: `fetch` runs **again** (cheap rsync since most files
  are already local — only re-checks). Then `teardown` runs and
  deletes the VM + disk. Both succeed if auth is alive. **Clean.**
- **Failure path (e.g., 12h wall-cap, inner crash, ssh hiccup
  prolonged)**: `run_remote` returns 1 → `set -euo pipefail` propagates
  → main body aborts → trap fires. `fetch` runs (pulls whatever is on
  disk; this is the partial-checkpoint recovery the v4 incident wrote
  the patch for). Then `teardown` runs. If `teardown` hits the
  expired-auth hang, the `|| true` does NOT stop the hang — it just
  prevents a non-zero exit from propagating. The trap will sit on the
  hung CLI call forever (this is what happened in v4 per
  `.swarm/STATUS.md` "v4 RUN TERMINATED").

### 6.2 Multi-tier smoke wrapper sketch

For "provision once → for each tier in 0_8b, 2b, 4b, 9b, 27b, 27b-256k,
27b-1m: smoke → fetch incrementally → final teardown":

```sh
#!/usr/bin/env bash
# scripts/smoke_all_tiers_nebius.sh
set -euo pipefail
TIERS=(qwen3.5-0.8b qwen3.5-2b qwen3.5-4b qwen3.5-9b)
QUANT_ONLY_TIERS=(qwen3.6-27b qwen3.6-27b-256k qwen3.6-27b-1m)  # all from same checkpoint
SMOKE_RUN_BASE="eliza-1-smoke-all-$(date +%s)"

cleanup() {
  echo "[smoke-all] teardown on exit"
  NEBIUS_VM_NAME="$VM" bash packages/training/scripts/train_nebius.sh teardown || true
}
trap cleanup EXIT

# Provision ONCE
VM="eliza-train-h200-smoke-$(date +%s)"
NEBIUS_VM_NAME="$VM" bash packages/training/scripts/train_nebius.sh provision

# Sync code ONCE
NEBIUS_VM_NAME="$VM" bash packages/training/scripts/train_nebius.sh sync

# For each tier: run smoke, fetch incrementally
for tier in "${TIERS[@]}"; do
  echo "[smoke-all] === tier $tier ==="
  REGISTRY_KEY="$tier" \
    NEBIUS_VM_NAME="$VM" \
    RUN_NAME="$SMOKE_RUN_BASE-$tier" \
    MAX_STEPS=50 \
    ELIZA_SAMPLE_PER_SOURCE=10 \
    bash packages/training/scripts/train_nebius.sh run
  # Per-tier fetch
  NEBIUS_VM_NAME="$VM" RUN_NAME="$SMOKE_RUN_BASE-$tier" \
    bash packages/training/scripts/train_nebius.sh fetch
done

# 27b quant-only passes share the same source checkpoint (pre-published
# HF Q4_K_M); --skip-finetune --skip-base-bench
for ctxtier in "${QUANT_ONLY_TIERS[@]}"; do
  echo "[smoke-all] === ctx-tier $ctxtier (quant only) ==="
  # ... similar invocation with --skip-finetune
done

# Teardown handled by trap.
```

This wrapper requires three small upstream patches:

1. `train_nebius.sh` needs an `ELIZA_SAMPLE_PER_SOURCE` env that
   plumbs `--sample-per-source N` + `--from-scratch` into the
   `run_pipeline.py` invocation (today the script always uses
   `data/final/{train,val,test}.jsonl` or
   `data/final-eliza1-fullcorpus/...`). Trivial patch
   (~5 lines around `train_nebius.sh:430-436`).
2. The `--skip-finetune` quant-only path needs to be plumbed in
   `train_nebius.sh` the same way `MAX_STEPS` is — currently the
   invocation hardcodes the full stack. Trivial.
3. A `train_nebius.sh fetch` invocation accepts `RUN_NAME` env
   (`train_nebius.sh:88-89` shows it does). Verified — no change.

### 6.3 OAuth refresh recommendation

The v4 incident root-caused the watcher self-termination to
`nebius iam` federation token expiry after ~7h. Options:

- **Cache a refresh token**: not supported by Nebius CLI v0.12.x in
  a non-interactive flow (per `.swarm/STATUS.md` H200-MONITOR-4 §
  "Why this is dangerous": "browser OAuth federation").
- **SSH-based-liveness watcher**: the v4 follow-up landed
  `/tmp/nebius-finish-q35-0_8b-v4b.sh` (template referenced in
  `.swarm/STATUS.md`) which uses SSH `nvidia-smi` reachability as the
  primary liveness probe and only uses `nebius` CLI for the final
  teardown. The canonical version is
  `packages/training/scripts/nebius_watcher.sh:1-174`.
  **Recommendation**: keep the SSH-based-liveness watcher as the
  canonical pattern and run a fresh `nebius iam whoami` check at the
  start of every wrapper script. If `whoami` returns non-zero or
  hangs >5s, refuse to provision.
- **Pre-flight auth check**: add this snippet at the top of
  `smoke_all_tiers_nebius.sh`:
  ```sh
  timeout 5s nebius iam whoami >/dev/null 2>&1 || {
    echo "[smoke-all] nebius CLI auth expired or unreachable — refusing to provision"
    echo "  run: ~/.nebius/bin/nebius iam get-access-token (browser-OAuth)"
    exit 1
  }
  ```

This refuses to start the sequence with an already-expired token and
catches the v4 failure mode pre-spend.

---

## Section 7 — Recommended implementation plan

### 7.1 Smoke corpus recipe

Inputs:

- **Static smoke mix**: `scripts/normalize.py --sample-per-source 10`
  → `scripts/pack_dataset.py --smoke --sample-per-source 10` →
  `data/final/{train,val,test}.jsonl`. This pulls 10 rows × ~80
  upstream sources ≈ 800 train rows.
- **Benchmark-aligned slice**: `datasets/eliza1-sft-0_6b/{train,val,test}.jsonl`
  (already in repo; ~21k train rows pre-prepared). Smoke pass takes
  the first 200 rows directly (no upsample, no full slice).
- **Recent scenario trajectories**: last 7 days of
  `source = scenario-runner` / `scenario-benchmark` / `live-scenarios`
  trajectories. Filter via the **new**
  `scripts/collect_recent_trajectories.py` (§5.5 option 1).
  Cap at ~500 rows. Privacy filter is mandatory and already in the
  ingestion path.

Concatenation order (mirrors `build_eliza1_fullcorpus.py:74-83`):
recent scenarios first, then benchmark-aligned slice, then static
smoke mix. This puts the highest-quality structured rows at the front
of the cosine warmup.

### 7.2 Per-tier smoke run command

```sh
# Inside train_nebius.sh-equivalent, on the remote VM
uv run --extra train python scripts/run_pipeline.py \
  --registry-key qwen3.5-0.8b \
  --run-name eliza-1-smoke-0_8b-$(date +%s) \
  --from-scratch --sample-per-source 10 \
  --epochs 0.01 --max-steps 50 \
  --lr 1e-5 --use-liger on \
  --eval-mode smoke --bench-per-bucket 10 \
  --quantizers polarquant,fused_turboquant,qjl \
  --eliza1-bundle \
  --skip-throughput-bench    # llama-bench output is noisy at 50 steps
```

For the 27b family (single-1×H200):

```sh
uv run --extra train python scripts/run_pipeline.py \
  --registry-key qwen3.6-27b \
  --run-name eliza-1-smoke-27b-$(date +%s) \
  --skip-finetune --skip-base-bench \
  --train-file /opt/training/datasets/eliza1-sft-0_6b/train.jsonl \
  --val-file /opt/training/datasets/eliza1-sft-0_6b/val.jsonl \
  --test-file /opt/training/datasets/eliza1-sft-0_6b/test.jsonl \
  --quantizers polarquant,fused_turboquant,qjl \
  --eliza1-bundle \
  --skip-throughput-bench
```

(Quant-only over the pre-published `Qwen/Qwen3.6-27B` Q4_K_M baseline.)

### 7.3 Orchestration loop

`scripts/smoke_all_tiers_nebius.sh` (sketch in §6.2). Single
provision → 4 sequential SFT smoke runs (0_8b → 2b → 4b → 9b) → 3
quant-only passes (27b → 27b-256k → 27b-1m) → final teardown via
EXIT trap. Per-tier `fetch` between iterations so failure of a later
tier doesn't lose earlier artifacts.

### 7.4 Pipeline patches needed

Prioritized:

1. **HIGH — `train_nebius.sh` smoke env plumbing**. Add
   `ELIZA_SAMPLE_PER_SOURCE` → `--from-scratch --sample-per-source N`
   passthrough, and a `SKIP_FINETUNE=1` shortcut. ~10 lines around
   `train_nebius.sh:430-436`.
2. **HIGH — `scripts/collect_recent_trajectories.py`**. New file,
   ~80 lines, reads PGlite via the existing
   `TrajectoriesService.listTrajectories` (or its node bridge) +
   serializes via `trajectory-export.ts`. Writes JSONL through
   `privacy_filter_trajectories.py`. Per §5.5 option (1).
3. **MEDIUM — `build_eliza1_smoke_mix.py`** (new). 30-line script
   that concatenates §7.1 inputs in order, deduplicates, applies the
   privacy filter once at the join point. Or, fold into the existing
   `build_eliza1_fullcorpus.py` via a `--sample-per-source N` flag.
4. **MEDIUM — `train_nebius.sh:608-619` trap hardening**. Add a
   `timeout 60s nebius compute v1 instance delete` so a hung CLI auth
   doesn't block the trap forever (the `|| true` is not enough — a
   `timeout` is). Or call the `nebius_watcher.sh` SSH-fallback path.
5. **LOW — `scripts/smoke_all_tiers_nebius.sh`** (new). Sketched in
   §6.2. ~60 lines. The actual orchestrator.
6. **LOW — `train_local.py:367-385` audit**. The PyTorch 2.6+
   `weights_only` fix **is already in source**. Verify it on the v5
   build (`git log -1 -- packages/training/scripts/train_local.py`)
   before relaunching. If a downstream pinned `apollo_torch` version
   moved `GradientProjector` out of the
   `apollo_torch.random_projector` submodule, the `add_safe_globals`
   call silently registers nothing — confirm `apollo_torch ==
   {pinned version}` and the module path are unchanged on the H200.

### 7.5 Wall-clock estimate for the full 7-tier sequence

Per §4.6, the full 7-tier sequence on one 1×H200 SXM:

| segment | time |
|---|---|
| Pre-flight (nebius `whoami`, repo sync prep) | 1 min |
| Provision Nebius VM | 3 min |
| First sync (`rsync packages/training/` + corpus) | 5 min |
| 0_8b smoke run (corpus build + 50 SFT + bench + quant + bundle) | 31 min |
| Per-tier fetch | 1 min |
| 2b smoke run | 41 min |
| Per-tier fetch | 1 min |
| 4b smoke run | 62 min |
| Per-tier fetch | 1 min |
| 9b smoke run | 115 min |
| Per-tier fetch | 1 min |
| 27b quant-only (skip-finetune, re-quant pre-published Q4_K_M) | 15 min |
| 27b-256k re-quant + bundle (long ctx) | 10 min |
| 27b-1m re-quant + bundle (long ctx) | 12 min |
| Final fetch (sweep all 7 run dirs) | 5 min |
| Teardown (instance delete + boot disk delete) | 1 min |
| **TOTAL** | **~5h 4m** |

Buffer for ssh hiccups / first-time cu128 torch swap on the box
(~10 min) → **plan for ~6h end-to-end**. Comfortable inside the 12h
`ELIZA_REMOTE_RUN_TIMEOUT_H` cap. Cost estimate at ~$3-4/GPU-h class
H200 SXM: **~$18–$24** for the full smoke sequence.

---

## Section 8 — Appendix: file:line citation index for key claims

- ELIZA_1_TIER_IDS: `packages/shared/src/local-inference/catalog.ts:20-28`.
- FIRST_RUN_DEFAULT_MODEL_ID: `catalog.ts:35`.
- ELIZA_1_VOICE_BACKENDS: `catalog.ts:127-138`.
- voiceQuantForTier: `catalog.ts:323-327`.
- sourceModelForTier: `catalog.ts:337-361`.
- TIER_SPECS: `catalog.ts:166-290`.
- APOLLO-only optimizer (`--optimizer` choices): `train_local.py:262-267`.
- ELIZA_TRAINER_OPTIM rejection: `train_local.py:506-510`.
- APOLLO weights_only resume fix: `train_local.py:367-385`.
- APOLLO factory builders: `optimizer.py:166-294`.
- Registry per-tier optimizer columns: `model_registry.py:293, :326, :347, :370, :392, :417`.
- AdamW/Muon ban comment: `model_registry.py:148-152`.
- Pipeline stage map: `run_pipeline.py:3-22`.
- `--sample-per-source` plumbing: `run_pipeline.py:308-316`, `normalize.py:208`, `pack_dataset.py:332-336`.
- `--max-steps` flag: `run_pipeline.py:206-212`, `train_local.py:74-84`.
- `train_nebius.sh full` trap and main flow: `train_nebius.sh:608-619`.
- `MAX_STEPS` env plumbing in nebius driver: `train_nebius.sh:62-66, 360-365, 432-433`.
- `ELIZA_REMOTE_RUN_TIMEOUT_H` watcher cap: `train_nebius.sh:459-466`.
- `fetch` function (end-only): `train_nebius.sh:473-480`.
- `teardown` function: `train_nebius.sh:561-578`.
- Trajectories DB schema: `TrajectoriesService.ts:1083-1140`.
- `listTrajectories` filter API: `TrajectoriesService.ts:2111-2172`.
- Privacy filter source: `plugins/app-training/src/core/privacy-filter.ts`.
- Privacy filter Python port: `prepare_eliza1_trajectory_dataset.py:75-194`.
- Trajectory recorder dir resolution: `trajectory-recorder.ts:355-372`.
- Postmortem (chat-template TypeError + PIPESTATUS bug): `packages/training/reports/eliza1-h200-postmortem-2026-05-12.md`.
- v4 incident (driver 6h cap, watcher auth-expiry): `.swarm/STATUS.md` "H200-MONITOR-3", "H200-MONITOR-4 FINAL UPDATE".
- e2e-audit per-tier matrix: `plugins/plugin-local-inference/native/reports/porting/2026-05-12/eliza1-e2e-audit-2026-05-12.md:180-282`.

---

End of audit.
