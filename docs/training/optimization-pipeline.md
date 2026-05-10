# Milady optimization pipeline

End-to-end recipe for taking a base HuggingFace causal-LM, applying every
Milady inference optimization (PolarQuant Q4 weights, QJL K-cache
projection, TurboQuant V-cache, DFlash speculative decoding) on top of
the `milady-ai/llama.cpp` v0.4.0-milady fork, and publishing the
resulting GGUF + manifest to an `elizaos/eliza-1-<tier>`
HuggingFace repo so phones can download it via the existing in-app
downloader.

## Why this exists

The Milady fork composes four non-upstream GGML types and a DFlash
spec-decode CLI surface:

| Slot | Type        | What it stores                                  | Source |
|------|-------------|-------------------------------------------------|---|
| 43   | `TBQ3_0`    | TurboQuant 3-bit V-cache                         | apothic/llama.cpp-1bit-turboquant cherry-pick |
| 44   | `TBQ4_0`    | TurboQuant 4-bit V-cache                         | apothic/llama.cpp-1bit-turboquant cherry-pick |
| 46   | `QJL1_256`  | QJL 1-bit JL-projected K-cache (256 sketch dims) | W1-A QJL series |
| 47   | `Q4_POLAR`  | PolarQuant 4-bit weight blocks                   | W1-B Polar series |

Each technique has a research-grade Python apply script under
`packages/training/scripts/quantization/`. The orchestrator at
`packages/training/scripts/optimize_for_milady.py` is the single entry
point that runs them in dependency order, drives the GGUF conversion
with the fork's `convert_hf_to_gguf.py`, and emits a runtime manifest
that the on-device downloader consumes.

## What each optimization buys

Numbers below are taken from the per-technique READMEs (last measured
on Eliza-1 lite / RTX 5080 Laptop unless noted).

| Technique    | Where it acts            | Win                                       | Cost |
|--------------|--------------------------|-------------------------------------------|------|
| PolarQuant Q4 | weights (offline)        | ~62% smaller checkpoint, ≤+0.3 PPL on Wikitext-2 | data-free apply, slow Python loop |
| QJL 1-bit    | K-cache (runtime)         | 7.53× K reduction at proj_dim=256 (head_dim=128) | needs CUDA kernel for prod inference |
| TurboQuant   | V-cache (runtime)         | 3.52× V reduction (114,688 → 32,608 B/token) | pure-PyTorch path is 5× slower than bf16; Triton kernel recovers it |
| DFlash       | speculative decoding     | 1.5–2.5× tok/s on matched-vocab drafter pairs | requires drafter + `llama-server --spec-type dflash` |
| Combined     | weights + KV + decode    | ~4× whole-model KV reduction, ~38% on-disk size, ~1.8× decode | runtime needs the milady-ai/llama.cpp fork |

Source: `packages/training/scripts/quantization/README.md` and
`docs/porting/unified-fork-strategy.md` §D.

## Components

```
packages/training/scripts/
  optimize_for_milady.py            ← master orchestrator (this doc)
  emit_milady_catalog.py            ← catalog.ts diff generator
  push_model_to_hf.py               ← HF publisher (extended with --milady-manifest)
  quantization/
    polarquant_apply.py             ← PolarQuant 4-bit weights
    qjl_apply.py                    ← QJL 1-bit K cache
    turboquant_apply.py             ← TurboQuant V cache (PyTorch reference)
    fused_turboquant_apply.py       ← TurboQuant V cache (Triton kernel; needs GPU)
    gguf_milady_apply.py            ← GGUF emit shim for Milady GGML types
```

### Apply order

PolarQuant runs first because it physically rewrites the model weights
(reconstruction back into fp16) and writes the int8 codes sidecar that
the GGUF converter packs as `Q4_POLAR` blocks. QJL and TurboQuant only
write JSON sidecars (`qjl_config.json`, `turboquant.json`) so they run
on the PolarQuant output. The dependency graph is:

```
base HF model
    ↓  polarquant_apply.py
stage-polarquant/  (HF ckpt + polarquant_artifacts.safetensors)
    ↓  qjl_apply.py
stage-qjl/         (HF ckpt + qjl_config.json)
    ↓  turboquant_apply.py
stage-turboquant/  (HF ckpt + turboquant.json)
    ↓  convert_hf_to_gguf.py (milady-ai/llama.cpp v0.4.0-milady)
gguf/<name>-milady-Q4_POLAR.gguf + milady_manifest.json + README.md
    ↓  push_model_to_hf.py --milady-manifest
HuggingFace: elizaos/eliza-1-<tier>
```

## Running it

### Dry-run (CPU-only smoke)

```bash
cd packages/training
uv run python scripts/optimize_for_milady.py \
    --base-model elizaos/eliza-1-lite-0_6b \
    --output-dir checkpoints/eliza-1-lite \
    --apply polarquant qjl turboquant \
    --hf-repo elizaos/eliza-1-lite-0_6b \
    --dry-run
```

The dry-run validates each apply script's argument shape, prints the
manifest the orchestrator would write, and never talks to HuggingFace.
TurboQuant is auto-skipped on CPU-only hosts (its calibration loop
requires CUDA); the manifest records the skip with a `reason` field so
consumers know the V-cache config falls back to the framework default.

### Production run (GPU-equipped runner)

```bash
HF_TOKEN=hf_xxx \
LLAMA_CPP_DIR=$HOME/src/milady-llama.cpp \
uv run python scripts/optimize_for_milady.py \
    --base-model elizaos/eliza-1-lite-0_6b \
    --output-dir checkpoints/eliza-1-lite \
    --apply polarquant qjl turboquant \
    --calibration data/final/val.jsonl \
    --calibration-samples 128 \
    --hf-repo elizaos/eliza-1-lite-0_6b
```

Production runs need:

- A GPU with CUDA for the TurboQuant calibration pass and (optionally)
  the QJL CUDA kernel build under `scripts/quantization/qjl/csrc/`.
- A local checkout of `milady-ai/llama.cpp` at tag `v0.4.0-milady`
  (commit `08032d57e15574f2a7ca19fc3f29510c8673d590`) at
  `$LLAMA_CPP_DIR`. The fork is the only place `convert_hf_to_gguf.py`
  understands `--outtype q4_polar`.
- An `HF_TOKEN` (or `HUGGINGFACE_HUB_TOKEN`) with write access to the
  `elizaos` HF org.

### Catalog wiring

After publish, run:

```bash
uv run python scripts/emit_milady_catalog.py \
    --manifest checkpoints/eliza-1-lite/gguf/milady_manifest.json \
    --catalog ../app-core/src/services/local-inference/catalog.ts \
    --output reports/training/catalog-eliza-1-lite.diff
```

The diff appends a `MODEL_CATALOG` entry pointing at the new HF repo,
with the runtime block populated from the manifest. The diff is
intentionally append-only so it composes cleanly with W5-Catalog's
purged baseline (the cleanup wave's deletions and this wave's additions
do not collide on the same lines).

## Expected file sizes

For Eliza-1 lite (base ~1.16 GB bf16, 484 MB Q4_K_M baseline):

| Stage             | Output                                  | Approx. size |
|-------------------|-----------------------------------------|--------------|
| base              | `elizaos/eliza-1-lite-0_6b` HF safetensors         | 1.16 GB |
| stage-polarquant/ | reconstructed fp16 + polar codes sidecar | 1.16 GB + 70 MB sidecar |
| stage-qjl/        | unchanged + qjl_config.json              | 1.16 GB + <1 KB |
| stage-turboquant/ | unchanged + turboquant.json              | 1.16 GB + <1 KB |
| gguf/             | `eliza-1-lite-Q4_POLAR.gguf`        | ~380 MB |

The GGUF is what phones download; the intermediate stage directories
stay on the build host.

## Runtime config (what the manifest documents)

The manifest's `runtime` block declares the exact `llama-server`
invocation phones run after download:

```bash
llama-server \
  --model eliza-1-lite-Q4_POLAR.gguf \
  --draft-model <drafter>.gguf \
  --spec-type dflash \
  --cache-type-k qjl1_256 \
  --cache-type-v tbq3_0
```

The `--cache-type-k qjl1_256` and `--cache-type-v tbq3_0` flags only
exist in the milady-ai fork; the manifest pins
`min_llama_cpp_tag: v0.4.0-milady` so a runtime that doesn't carry the
fork can refuse the model up front instead of failing at first
inference call.

## Verified outputs (dry-run on Eliza-1 lite)

```
$ uv run python scripts/optimize_for_milady.py \
      --base-model elizaos/eliza-1-lite-0_6b \
      --output-dir /tmp/eliza-1-lite-test \
      --apply polarquant qjl turboquant \
      --hf-repo elizaos/eliza-1-lite-0_6b --dry-run
…
2026-05-10 02:49:01 polarquant_apply --dry-run → exit=0 (6.0s)
2026-05-10 02:49:04 qjl_apply --dry-run → exit=0 (3.2s)
2026-05-10 02:49:04 turboquant skipped — CUDA unavailable
2026-05-10 02:49:04 (dry-run) GGUF target = eliza-1-lite-Q4_POLAR.gguf
2026-05-10 02:49:04 (dry-run) push to elizaos/eliza-1-lite-0_6b
2026-05-10 02:49:04 pipeline ok
```

The dry-run on this CPU-only Linux x86_64 box validates:

- PolarQuant apply CLI parses (`--dry-run` exit=0).
- QJL apply CLI parses on `--device cpu`.
- TurboQuant is correctly identified as needing CUDA and is skipped
  with a manifest entry (`applied: false, reason: "CUDA unavailable"`).
- The GGUF target filename is computed correctly from the Eliza-1 tier
  slug (`eliza-1-lite-Q4_POLAR.gguf`).
- The manifest serializes with the right GGML type slot numbers
  (`Q4_POLAR=47`, `QJL1_256=46`, `TBQ3_0=43`).
- The runtime block declares the exact `llama-server` flag set the
  Milady fork understands.
- `push_model_to_hf.py --milady-manifest` accepts the manifest and
  renders a README.md using the manifest's runtime block (no template
  fallback).

## Hardware constraints

- **PolarQuant**: data-free, pure CPU. Always runs.
- **QJL**: calibration is a forward pass that fits on CPU for sub-3B
  models. The CUDA kernel under `scripts/quantization/qjl/csrc/`
  handles inference, not apply.
- **TurboQuant** (`turboquant_apply.py`): pure-PyTorch reference path
  imports `turbokv` and currently requires CUDA in its `--device`
  default; the orchestrator forces `--device cpu` on CUDA-less hosts.
- **Fused TurboQuant** (`fused_turboquant_apply.py`): Triton-kernel
  path. GPU-only.
- **GGUF conversion**: pure Python, but the converter must come from
  the `milady-ai/llama.cpp` fork (upstream `convert_hf_to_gguf.py`
  rejects `--outtype q4_polar`).

For a CPU-only smoke run on this Linux x86_64 dev box, the orchestrator
applies PolarQuant + QJL and skips TurboQuant. The published manifest
records the skip; downstream consumers fall back to the framework
default V-cache config (also `tbq3_0`, but with no calibrated
skip-layer set). Production runs should target a GPU runner so the
TurboQuant calibration produces a real `skip_layers` profile.

## Pin reference

| Component                      | Pin |
|--------------------------------|-----|
| `milady-ai/llama.cpp` tag      | `v0.4.0-milady` |
| `milady-ai/llama.cpp` commit   | `08032d57e15574f2a7ca19fc3f29510c8673d590` |
| `milady-ai/llama.cpp` remote   | https://github.com/milady-ai/llama.cpp.git |
| AOSP build script              | `packages/app-core/scripts/aosp/compile-libllama.mjs` |
| Host build script              | `packages/app-core/scripts/build-llama-cpp-dflash.mjs` |
| `apothic/llama.cpp-1bit-turboquant` (TBQ origin) | `b2b5273e8b27` (cherry-picked into fork) |
| QJL upstream commit            | `648b3641f96b6e95e091217220b94e4739fd4d82` |
| PolarQuant upstream commit     | `15a12160245d7d3015290c6c5b6dbb7f22094d5e` |

## Out of scope for this pipeline

- Catalog purge (W5-Catalog) — emit_milady_catalog.py only emits the
  append diff; it does not delete other catalog entries.
- HF org provisioning (W5-HF-Org) — this script assumes the
  `milady-ai` org exists and the operator's `HF_TOKEN` has write
  access.
- Android testing (W5-Android) — the manifest documents the runtime
  invocation; verifying it on a real Pixel is a separate wave.
- Production-scale optimization runs — needs a GPU runner. This
  orchestrator is validated end-to-end in dry-run on a CPU-only
  Linux x86_64 box.
