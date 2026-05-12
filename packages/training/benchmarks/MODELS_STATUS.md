# Eliza-1 model tier status

Quick reference for what each `model_registry.py` tier is, where it can train,
and what command runs the SFT. Source of truth for tier geometry / budgets is
`scripts/training/model_registry.py`; this file is the operator-facing summary.

## Runtime auto-default semantics (2026-05-12)

A `base-v1-candidate` bundle (the publish-side state when not every
release-blocking gate is green) is **publishable, installable, AND
allowed to auto-fill an empty default slot** on a device whose backend
the manifest verified `pass`. The on-device gate
(`canSetAsDefault` in `packages/app-core/src/services/local-inference/manifest/validator.ts`)
no longer hard-requires `manifest.defaultEligible === true`; it requires
the manifest to be contract-valid, the device RAM to meet the floor, and
at least one tier-supported backend to be verified-pass.

When both a strict release (`defaultEligible: true`) and a candidate
bundle are installed, the recommender prefers the strict release. The
candidate-as-default path exists so a fresh install of
`elizaos/eliza-1-{0_6b,1_7b,...}` lands the user in chat with the
downloaded bundle already wired to `TEXT_SMALL` / `TEXT_LARGE` instead of
stranding them on an installed-but-unused model.

## Local tiers (16 GB consumer GPU, RTX 5080 Laptop class)

> **Backbone move (owner decision):** the small eliza-1 tiers move to the
> Qwen3.5 family — `Qwen/Qwen3.5-0.8B` (→ `eliza-1-0_8b`, the new small
> default) and `Qwen/Qwen3.5-2B` (→ `eliza-1-2b`, already here). Both are
> published on the Hub. The DFlash speculative-decode drafter for the
> Qwen3.5/3.6 target tiers (`eliza-1-{2b,9b,27b,27b-256k,27b-1m}`) is now a
> Qwen3.5-backbone model — distilled DOWN from `Qwen/Qwen3.5-0.8B-Base` to
> ~0.6B params (a smaller Qwen3.5-arch student; `scripts/distill_dflash_drafter.py`),
> because it must share the targets' 248320-token Qwen3.5 tokenizer (a
> Qwen3-0.6B drafter has the wrong vocab). The legacy Qwen3 tiers
> (`eliza-1-1_7b` → drafter `Qwen/Qwen3-0.6B`) keep the Qwen3 vocab.
>
> **TODO(owner):** should the legacy Qwen3 small tiers (`eliza-1-0_6b` /
> `eliza-1-1_7b` / `eliza-1-4b`) be (a) kept as a legacy line alongside the
> new Qwen3.5 line, (b) dropped entirely, or (c) `eliza-1-1_7b` replaced by
> `eliza-1-0_8b` + `eliza-1-2b` as the small defaults? They are kept
> additively for now; `FIRST_RUN_DEFAULT_MODEL_ID` (`catalog.ts`) is left on
> `eliza-1-1_7b`. Decide before publishing.

| registry key | published name | base | seq_len | train budget | runs locally? |
|---|---|---|---:|---:|---|
| `qwen3.5-0.8b` | `eliza-1-0_8b` | Qwen/Qwen3.5-0.8B | 4096 | 12 GB | yes (new smallest tier; whole train→quant→bench stack < 1 h; Liger helps the 248k-vocab CE) |
| `qwen3-0.6b` | `eliza-1-0_6b` | Qwen/Qwen3-0.6B | 4096 | 10 GB | yes (legacy Qwen3 tier; whole train→quant→bench stack < 1 h) |
| `qwen3-1.7b` | `eliza-1-1_7b` | Qwen/Qwen3-1.7B | 4096 | 15 GB | yes (legacy Qwen3 tier; drop seq to 2k if peak > 15 GB) |
| `qwen3-4b`   | `eliza-1-4b`   | Qwen/Qwen3-4B   | 4096 | 24 GB | legacy Qwen3 tier; needs a 24 GB card (4090 / A5000 / L4) |
| `qwen3.5-2b` | `eliza-1-2b`   | Qwen/Qwen3.5-2B | 8192 | 15.5 GB | yes (Liger required for the 8k window) |

Local SFT entrypoint (driven by `run_pipeline.py`, which calls `train_local.py`):

```bash
uv run python scripts/run_pipeline.py --registry-key qwen3-0.6b --epochs 3
# overridable knobs (0 = registry default):
#   --micro-batch 2 --grad-accum 4   # +20-40% samples/sec on the 0.6B at no quality cost
#   --max-seq-len 8192               # only after Liger is working; validate with memory_calc.py first
```

Throughput / context-scaling numbers: `benchmarks/THROUGHPUT.md`,
`packages/shared/src/local-inference/CONTEXT_SCALING.md`. APOLLO config audit
+ memory math: `benchmarks/APOLLO_TUNING.md`.

Benchmark-aligned SFT dataset for the 0.6b (focused mix-in; not the full
`data/final` corpus): `datasets/eliza1-sft-0_6b/` — ChatML `{"messages":[...]}`
rows (`train_local.py --train-file` compatible), built by
`scripts/build_eliza1_sft_0_6b.py` from `action-selection-cases.ts` +
personality-bench calibration sets, augmented with Cerebras `gpt-oss-120b`
(`CEREBRAS_API_KEY` env). See `datasets/eliza1-sft-0_6b/README.md` for the task
mix, eval-alignment rationale, and the HF upload manifest. Use it standalone for
the 0.6b or concatenate ahead of `data/final/train.jsonl`.

## Cloud tiers (9B / 27B — cannot train on a 16 GB laptop GPU)

These two tiers train against the next-gen Qwen3.5/3.6 dense checkpoints and
require datacenter GPUs. Full-parameter APOLLO + Liger SFT on a 16 GB consumer
card OOMs before the first step — do not attempt locally; use Vast (canonical)
or Nebius (deprecated fallback).

| registry key | published name | base | seq_len | train budget (world-aggregate) | GPU requirement |
|---|---|---|---:|---:|---|
| `qwen3.5-9b` | `eliza-1-9b` | Qwen/Qwen3.5-9B | 16384 | ~80 GB | 1× H200 SXM / A100-80 (single GPU, no FSDP needed) — or `blackwell6000-1x` (96 GB) on Vast |
| `qwen3.6-27b` | `eliza-1-27b` | Qwen/Qwen3.6-27B | 65536 | ~190 GB | 2× H200 SXM (FSDP) — or `b200-2x` (~366 GB) on Vast; single H200 OOMs even at seq 8k |

### Vast.ai (canonical)

`scripts/train_vast.sh` auto-picks the GPU target and FSDP world size from
`(PIPELINE, REGISTRY_KEY)`. One-shot provision + sync + train:

```bash
# eliza-1-9b (Qwen3.5-9B) — auto-selects blackwell6000-1x (96 GB, ~83% util at the 80 GB budget)
bash scripts/train_vast.sh provision-and-train --registry-key qwen3.5-9b --epochs 1 [--bootstrap rsync|hf]

# eliza-1-27b (Qwen3.6-27B) — auto-selects b200-2x (~366 GB, FSDP, ~52% util at the 190 GB budget)
bash scripts/train_vast.sh provision-and-train --registry-key qwen3.6-27b --epochs 1 [--bootstrap rsync|hf]
```

`--dry-run` prints the provision + sync + `accelerate launch train_local.py
--registry-key <key>` plan without spending Vast hours (cents locally, saved
several hundred $ of wasted hours during the 2026-05 smoke runs). The script's
`run` / `quantize` / `bench` / `fetch` subcommands run the post-training
quantize + base-vs-finetuned bench on the remote box and rsync the checkpoints
back. Budget cap: `ELIZA_VAST_MAX_USD` (warn) / 1.5× that (hard auto-teardown).

### Nebius (deprecated — emergency fallback only)

`scripts/train_nebius.sh` is kept for emergencies; do not extend it. It
provisions an H200 VM, syncs `training/`, and runs the same `train_local.py`
APOLLO SFT:

```bash
# eliza-1-27b on 2× H200 SXM (default preset gpu-h200x2)
REGISTRY_KEY=qwen3.6-27b bash scripts/train_nebius.sh full

# eliza-1-9b on a single H200 — halve the bill by switching the preset
REGISTRY_KEY=qwen3.5-9b NEBIUS_VM_PRESET=gpu-h200x1 bash scripts/train_nebius.sh full
```

Both cloud scripts call `scripts/train_local.py` directly under
`accelerate launch` for the FSDP launch (not `run_pipeline.py` — the pipeline
wrapper drives the local single-GPU stack and the corpus build; the cloud
scripts handle provisioning + sync + FSDP launch + remote quantize/bench
themselves). The model registry still drives `micro_batch` / `grad_accum` /
`seq_len` for the chosen `REGISTRY_KEY`.

## Measured — model geometry, run status, throughput (RTX 5080 Laptop 16 GB, sm_120, CUDA 13; 2026-05-11)

### Base-model geometry (the upstream bases are all on HF; the `elizaos/eliza-1-*` bundle repos now exist — `elizaos/eliza-1-{0_6b,1_7b,9b}` are public and currently re-host the upstream Qwen3-GGUF base bytes as `releaseState: local-standin` / `publishEligible: false` / not `defaultEligible`; the fork-built `base-v1` weights are not pushed yet. The 0.6B test-SFT checkpoint is published as a **candidate** at `elizaos/eliza-1-0_6b-sft-weights` — not `defaultEligible`, not the `recommended` channel. SFT corpora: `elizaos/eliza-1-0_6b-sft` + `elizaos/eliza-1-training`. Bench tables + kernel-verify evidence: `elizaos/eliza-1-evals`.)

| tier | base | arch | layers | n_heads / n_kv | head_dim | hidden | vocab | max_pos | notes |
|---|---|---|---:|---|---:|---:|---:|---:|---|
| `eliza-1-0_8b` | Qwen3.5-0.8B | **qwen3_5 (VLM)** | text 24 (6 full-attn) | 8 / 2 | 256 | 1024 | 248 320 | 262 144 | **new smallest tier**; **hybrid linear-attention** (`full_attention_interval=4` — 3:1 linear:full → 6 of 24 layers KV-bearing); 248k vocab → bigger CE transient (Liger helps); full SFT fits 16 GB at seq 4096; shares the 248k tokenizer with 2b/9b/27b — also the DFlash drafter base for those |
| `eliza-1-0_6b` | Qwen3-0.6B | qwen3 | 28 | 16 / 8 | 128 | 1024 | 151 936 | 40 960 | legacy Qwen3 small tier; full SFT fits 16 GB at seq 4096 |
| `eliza-1-1_7b` | Qwen3-1.7B | qwen3 | 28 | 16 / 8 | 128 | 2048 | 151 936 | 40 960 | legacy Qwen3 small tier; SFT fits 16 GB at **seq ≤ 2048** without Liger (seq 4096 OOMs on the CE step) |
| `eliza-1-4b`  | Qwen3-4B  | qwen3 | 36 | 32 / 8 | 128 | 2560 | 151 936 | 40 960 | legacy Qwen3 tier; needs ~24 GB for full SFT; calibration fits 16 GB |
| `eliza-1-2b`  | Qwen3.5-2B | **qwen3_5 (VLM)** | text 24 (6 full-attn) | 8 / 2 | 256 | 2048 | 248 320 | 262 144 | **hybrid linear-attention** (`full_attention_interval=4` — 3:1 linear:full); 248k vocab → big CE transient; needs Liger or a very short seq for SFT |
| `eliza-1-9b`  | Qwen3.5-9B | qwen3_5 | text 32 | 16 / 4 | 256 | 4096 | 248 320 | — | cloud only (see above) |
| `eliza-1-27b` | Qwen3.6-27B | qwen3_6 | text 64 | 24 / 4 | 256 | 5120 | 248 320 | — | cloud only (see above) |

### Run status

> **Master harness benchmark (2026-05-12):** one comparison run across every model +
> kernel artifact on this box — `reports/eliza1-harness-benchmark-2026-05-12.{md,json}`
> (also published to `elizaos/eliza-1-evals`, top-level `harness-benchmark-2026-05-12.md`).
> Highlights: test-SFT 0_6b beat base on every text metric (`format_ok` 0.0857→0.20,
> `claude_distill` format 27.3→63.6%, `reply` parse-errs 8→0); CPU `llama-bench` d0 —
> test-SFT Q4_K_M 500 pp / 75.6 tg, eliza1-bundle 0_6b Q3_K_M 331 / 77.7, q4_polar/Q8-body
> 432 / 61.1, 1_7b 219 / 39.6; RTX5080-Vulkan d0 — 0_6b 3421 / 194, 1_7b 1317 / 112;
> dflash accept 0_6b 0.87 (clears 0.6) / 1_7b 0.55 (misses 0.65); text-eval ppl→0..1
> 0_6b 0.2779 / 1_7b 0.328 (neither clears the gate — stand-in weights); voice RTF 8.62 /
> 5.91 (CPU stand-in TTS), ASR WER 1.0 (stand-in chain), guided-decode 28% forced-token
> (static); kernel-verify CPU pass / CUDA runtime-ready (8/8 RTX 5080) / Vulkan pass /
> Metal needs-hardware. Full-corpus SFT 0_6b in flight (ETA ~2026-05-13). action-selection
> + personality benches not run (need a live LLM provider + judge model).

| tier | SFT | GGUF | eliza1-bundle (polarquant+qjl+turboquant) | bench (CUDA, `-fa 1 -b 2048 -ngl 99`) |
|---|---|---|---|---|
| `eliza-1-0_6b` | 🔄 **full-corpus run in flight** — APOLLO `apollo_mini` full-param, 1 epoch over the 68,297-row combined corpus (`data/final-eliza1-fullcorpus/`: `datasets/eliza1-sft-0_6b/train.jsonl` ahead of `data/final/train.jsonl`, built by `scripts/build_eliza1_fullcorpus.py`), seq 4096, Liger on, lr 1e-5; run `eliza-1-0_6b-apollo-fullcorpus-1778563093` on the RTX 5080 (~12.7 s/it ⇒ ~30 h wall); `run_pipeline.py --eval-mode full` auto-chains the gate bench + quant + eliza1 bundle at the tail. Log: `checkpoints_run_eliza-1-0_6b-apollo-fullcorpus-1778563093.log`; report `reports/eliza1-0_6b-apollo-fullcorpus-2026-05-12.md`. — _Prior test-SFT (8000 samples / 1 epoch, eval_loss 1.315, `checkpoints/eliza-1-0_6b-apollo-1778551769/final/`): beat base `Qwen3-0.6B` on every metric, regressed none (`format_ok` 0.0857→0.20, `reply` parse-errors 8→0, `claude_distill` format 27.3%→63.6%, gen tps +33%) but did not clear the absolute `format_ok` 0.7 floor on the 35-row smoke corpus → conditional go; `reports/eliza1-0_6b-apollo-sft-2026-05-11.md`._ Nebius H200 fallback (if headless auth gets fixed): `NEBIUS_PROJECT_ID=project-e00kfz6cpr00q21z892vec bash scripts/cloud/run-on-cloud.sh --provider nebius --task train --gpu h200 --tier 0_6b --yes-i-will-pay`. No DFlash drafter for this tier (no smaller Qwen3 base) → nothing to re-stamp. | ✅ Q4_K_M, 396 MB (test-SFT; full-corpus GGUF pending) | ✅ sidecars on the test-SFT (`polarquant_artifacts.safetensors` + `qjl_config.json` + `turboquant.json` + `eliza1_manifest.json`); GGUF body is **Q8_0**, not native `Q4_POLAR` — `weight_quant.deferred: true` (the fork's `convert_hf_to_gguf.py` doesn't emit `q4_polar` yet; runtime kernels exist). Full-corpus bundle pending the run. | Q4_K_M (test-SFT): ~27.8 k pp512 / ~384 tg128 @ d0, ~6.6 k pp / ~125 tg @ d16k. eliza1-bundle Q8_0: ~31 k pp512 / ~392 tg128 @ d0 |
| `eliza-1-1_7b` | ✅ **done** — seq 4096 OOM'd on the CE step (16 GB, no Liger, 152k-vocab logits transient) → re-ran at **`--max-seq-len 2048`** (fits, ~15.3 GB peak); APOLLO `apollo_mini` full-param, eval_loss **1.268**, ~54 min wall; `checkpoints/eliza-1-1_7b-apollo-1778558722/final/`. `run_pipeline.py` auto-chained the tail: finetuned bench → GGUF → eliza1-bundle → throughput-bench (`benchmarks/eliza-1-1_7b-apollo-1778558722/pipeline-summary.json`). | ✅ via the eliza1-bundle: `final-Q4_POLAR.gguf`, **1.83 GB** — body is **Q8_0**, not native `Q4_POLAR` (`weight_quant.deferred: true`, same converter gap as 0.6b) | ✅ sidecars: `polarquant_artifacts.safetensors` + `qjl_config.json` (calibrated) + `turboquant.json` (calibrated `tbq3_0` V-cache) + `eliza1_manifest.json` at `checkpoints/eliza-1-1_7b-apollo-1778558722/eliza1-optimized/` | ⚠️ throughput.json says 80.6 pp / 14.4 tg — those are **CPU-tier**: `_throughput_bench` resolved the CPU `llama-bench` (`packages/inference/llama.cpp/build/bin/`, no CUDA), not a CUDA build. Re-run idle for real numbers: `~/.cache/eliza-dflash/milady-llama-cpp/build-cuda/bin/llama-bench -m <gguf> -ngl 99 -fa 1 -b 2048 -d 0,16384`. (`_resolve_llama_bench` should prefer a CUDA build over the CPU one — punch-listed.) |
| `eliza-1-0_8b` | pending — new smallest tier (Qwen3.5-0.8B, `qwen3_5` VLM + hybrid linear-attn). Needs the `qwen3_5` model class loadable; full-param `apollo_mini` SFT at seq 4096 (~12 GB budget), Liger helps the 248k-vocab CE. `uv run python scripts/run_pipeline.py --registry-key qwen3.5-0.8b --epochs 3`. | pending | pending | pending |
| `eliza-1-4b`  | pending — legacy Qwen3 tier; will try full SFT (expect OOM at seq 4096 on 16 GB → fall back to: download Qwen3-4B → Q4_K_M GGUF → bench + run the quant-chain *calibration* forward passes which do fit 16 GB) | pending | pending | pending |
| `eliza-1-2b`  | pending — qwen3_5 VLM + hybrid linear-attn; needs the qwen3_5 model class loadable + Liger (248k vocab) or a tiny seq for SFT; will try `--max-samples 1000 --max-seq-len 1024` | pending | pending | pending |
| `eliza-1-9b` / `eliza-1-27b` | cloud only — `bash scripts/train_vast.sh provision-and-train --registry-key qwen3.5-9b` / `--registry-key qwen3.6-27b` | — | — | — |

### Optimization-applicability per tier

- **Flash attention** (`-fa 1`, `optimizations.flashAttention: true` in `catalog.ts runtimeFor()`) — all tiers. +25 % prefill.
- **PolarQuant Q4_POLAR weights** (4.25 bpw) — produced as a sidecar for every locally-built tier; *baked into the GGUF* once the fork's converter emits `q4_polar` (currently deferred → q8_0 fallback, honestly recorded).
- **QJL1_256 K-cache + TBQ3_0/TBQ4_0 V-cache** — catalog default for any context > 8 k; the fork's CUDA `fattn-vec-instance-{tbq3_0,tbq4_0}.cu` kernels implement the TBQ side; the standalone `qjl_*` kernels implement the K side (not yet a `fattn-vec` instance — punch-listed). `llama-cli`/`llama-server` accept `--cache-type-{k,v} tbq3_0|tbq4_0`; `llama-cli` does **not** accept `qjl1_256` (only `llama-server` does), and `llama-bench` accepts neither — so QJL K-cache throughput is measured via the inference team's e2e/kernel benches, not `llama-bench`.
- **DFlash speculative decode** — wired in `catalog.ts` for 1.7b+. Drafter student base per target tier (`model_registry.DFLASH_DRAFTER_BASE` / `distill_dflash_drafter.DEFAULT_STUDENT_BASE`): legacy Qwen3 targets (1.7b/4b) → `Qwen/Qwen3-0.6B`; **Qwen3.5/3.6 targets (2b/9b/27b/27b-256k/27b-1m) → `Qwen/Qwen3.5-0.8B-Base`** — the shipped drafter GGUF is that base distilled DOWN to ~0.6B params (a smaller `qwen3_5`-arch student), because the drafter MUST share the target's 248320-token Qwen3.5 tokenizer (a Qwen3-0.6B drafter has the wrong vocab). ≈ 2–3× gen for the big tiers once the drafter is distilled (`scripts/distill_dflash_drafter.py`, cloud GPU). The 0.6b / 0.8b tiers get no drafter (smallest tiers).
- **APOLLO** (`apollo_mini` rank-1 for all but 9b which is full `apollo` rank-512) — the optimizer that makes 0.8b/0.6b/1.7b full-param SFT fit a consumer GPU. Liger (FLCE chunked CE) is the thing that would let 1.7b SFT at seq 4096 / 0.8b / 2b at seq 8192 on 16 GB — currently broken (Triton can't JIT without `python3.12-dev`); `train_local.py` probes and falls back to HF defaults instead of crashing.
