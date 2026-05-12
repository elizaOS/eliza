# Eliza-1 deployment matrix

Three published Eliza-1 fine-tunes × five hosting paths. Each row picks a
quant flavor that's appropriate for the target hardware; the `cell`
columns name the canonical config file and the runtime that consumes it.

| Size                | Local (Eliza)               | Ollama (local)                                    | vLLM (self-host)                                                   | Vast pyworker (autoscale)            | Eliza Cloud  |
|---------------------|------------------------------|---------------------------------------------------|---------------------------------------------------------------------|--------------------------------------|--------------|
| **eliza-1-2b**      | `ELIZA_MODEL=eliza-1-2b`    | `ollama/Modelfile.eliza-1-2b-q4_k_m`              | `serve_vllm.py --registry-key eliza-1-2b --gpu-target single`       | `vast-pyworker/eliza-1-2b.json`      | `vast/eliza-1-2b` (catalog entry pending) |
| **eliza-1-9b**      | `ELIZA_MODEL=eliza-1-9b`    | `ollama/Modelfile.eliza-1-9b-q4_k_m`              | `serve_vllm.py --registry-key eliza-1-9b --gpu-target h100-2x`      | `vast-pyworker/eliza-1-9b.json`      | `vast/eliza-1-9b` (catalog entry pending) |
| **eliza-1-27b**     | `ELIZA_MODEL=eliza-1-27b`   | `ollama/Modelfile.eliza-1-27b-q4_k_m`             | `serve_vllm.py --registry-key eliza-1-27b --gpu-target h200-2x`     | `vast-pyworker/eliza-1-27b.json`     | `vast/eliza-1-27b` (catalog entry pending) |

The "catalog entry pending" annotation reflects that
`eliza/cloud/packages/lib/models/catalog.ts` only has
`vast/eliza-1-27b` today. Adding the `vast/eliza-1-*` entries
is a one-line PR per id (mirror the existing row), but is owned by the
cloud monorepo, not this directory.

The `ELIZA_MODEL` env var is read by the runtime via
`eliza/packages/app-core/src/runtime/local-model-resolver.ts`, which
auto-picks the right quant flavor (gguf / polarquant / fp8 / bf16) for
the detected GPU and pulls the matching HF sibling repo on first run.

## Recommended pick per use case

### Local dev — single laptop / desktop
- **Default**: `eliza-1-2b` via Ollama. Build the Modelfile under
  `ollama/`, then export `OLLAMA_LARGE_MODEL=eliza-1-2b`. Runs on any
  16 GB consumer GPU and on Apple Silicon (Metal).
- **Workstation upgrade**: `eliza-1-9b` if you have a 24+ GB card.

### Single-user prod — one user, persistent personal assistant
- **24 GB workstation**: `eliza-1-9b` Q4_K_M via Ollama. The
  PolarQuant sibling repo exists for the local-runtime path
  (`scripts/quantization/polarquant_apply.py`) but mainline vLLM has
  no PolarQuant kernel today, so the vLLM serving recipe runs on the
  bf16 base repo with FP8 W8A8 + FP8 KV on Hopper.
- **48 GB+ workstation**: `eliza-1-27b` Q4_K_M via Ollama, or
  `eliza-1-27b` bf16 via vLLM if FP8 is unavailable on the card.

### Multi-tenant prod — many concurrent users
- **Cloud GPU**: `eliza-1-27b` via Eliza Cloud (`vast/eliza-1-27b`,
  catalog entry pending). The `vast-pyworker/eliza-1-27b.json`
  manifest targets 2x H200 SXM at FP8 weights + FP8 KV. Vast
  Serverless autoscales workers based on queue depth. (TurboQuant KV
  per vLLM PR #38479 will halve the KV footprint once that lands in
  mainline; today's manifest uses the safe `fp8_e4m3` fallback.)
- **Burst pattern with predictable baseline**: keep one always-warm
  worker (`min_workers=1`, `inactivity_timeout=-1`) and let Vast scale
  out to `max_workers=8` on demand. Costs ~$2/hr baseline (one H200
  worker) + per-request capacity.
- **Edge / low-latency**: deploy `eliza-1-9b` on Vast against H100 PCIe
  / H200 cards (`h100-2x` target). Cheaper than 27B and geographically
  distributable.

## Cost estimate per million tokens served

Rough order-of-magnitude numbers, dominated by GPU rental cost on Vast
spot at typical 2026 rates. Decode throughput estimates assume the
full vLLM stack from `serve_vllm.py` (CUDA graphs + chunked prefill +
prefix caching) at decode batch size 32.

| Row | Hardware | Hourly $ | Decode tok/s | $ / 1M output tokens |
|-----|---------|---------:|-------------:|---------------------:|
| 2B / vLLM bf16 / single L40S       | 1x L40S 48 GB | $0.40 | ~3500 | $0.03 |
| 2B / GGUF Q4_K_M / RTX 4090        | 1x RTX 4090 24 GB | $0.30 | ~2200 | $0.04 |
| 9B / vLLM FP8 / h100-2x            | 2x H100 PCIe 80 GB | $1.80 | ~3200 | $0.16 |
| 9B / GGUF Q4_K_M / RTX 5090        | 1x RTX 5090 32 GB | $0.50 | ~1100 | $0.13 |
| 27B / vLLM FP8 / h200-2x           | 2x H200 SXM 141 GB | $4.00 | ~1800 | $0.62 |
| 27B / GGUF Q6_K / RTX 5090         | 1x RTX 5090 32 GB | $0.50 | ~700 | $0.20 |

These rows are projections at the typical cloud-spot rates we observe
on Vast for the matching hardware classes; numbers will need
revisiting once we have measured throughput on a trained eliza-1
checkpoint. Vast spot prices and decode tok/s vary with offer
availability, batch size, and prompt mix. These are rentals only; the
Eliza Cloud customer-facing markup goes on top per the standard Cloud
pricing model.

## HuggingFace model layout

`scripts/push_model_to_hf.py` writes one HF repo per (size × quant
level), suffixing the registry's `eliza_repo_id` with the quant flag.
For GGUF this means a separate repo per K-quant level, NOT an umbrella
`-gguf` repo.

| Size | Base (bf16) | GGUF Q4_K_M | GGUF Q5_K_M | GGUF Q6_K | PolarQuant | FP8 |
|------|-------------|-------------|-------------|-----------|------------|-----|
| 2B   | `elizaos/eliza-1-2b`    | `elizaos/eliza-1-2b-gguf-q4_k_m`    | `elizaos/eliza-1-2b-gguf-q5_k_m`    | `elizaos/eliza-1-2b-gguf-q6_k`    | `elizaos/eliza-1-2b-polarquant`    | — (skipped, bf16 is small enough) |
| 9B   | `elizaos/eliza-1-9b`    | `elizaos/eliza-1-9b-gguf-q4_k_m`    | `elizaos/eliza-1-9b-gguf-q5_k_m`    | `elizaos/eliza-1-9b-gguf-q6_k`    | `elizaos/eliza-1-9b-polarquant`    | — (skipped, bf16 is small enough) |
| 27B  | `elizaos/eliza-1-27b`   | `elizaos/eliza-1-27b-gguf-q4_k_m`   | `elizaos/eliza-1-27b-gguf-q5_k_m`   | `elizaos/eliza-1-27b-gguf-q6_k`   | `elizaos/eliza-1-27b-polarquant`   | `elizaos/eliza-1-27b-fp8` |

None of these repos exist until `scripts/publish_all_eliza1.sh` runs
against a trained checkpoint. The smaller sizes skip explicit FP8
publish because vLLM compiles FP8 W8A8 from bf16 weights at load on
Hopper, so the bf16 base repo is enough for FP8 serving.

## Subdirectory map

```
cloud/
├── README.md             ← this file
├── ollama/               ← Modelfiles for ollama (per size, Q4_K_M)
│   ├── README.md
│   ├── Modelfile.eliza-1-2b-q4_k_m
│   ├── Modelfile.eliza-1-9b-q4_k_m
│   └── Modelfile.eliza-1-27b-q4_k_m
├── vast-pyworker/        ← Vast.ai serverless manifests
│   ├── README.md
│   ├── eliza-1-2b.json
│   ├── eliza-1-9b.json
│   └── eliza-1-27b.json
└── scripts/
    └── eliza-cloud-register.sh   ← upsert templates + endpoints in one shot
```

Reference docs in the wider repo:
- `training/scripts/training/model_registry.py` — Python source of truth
  for sizes, quant siblings, and KV budgets.
- `training/scripts/inference/serve_vllm.py` — canonical vLLM CLI; all
  per-target args here mirror its `GPU_TARGETS` table.
- `eliza/cloud/services/vast-pyworker/` — the existing pyworker that
  fronts the GGUF / llama-server path on Vast (Q6_K 27B today).
- `eliza/packages/app-core/src/runtime/local-model-resolver.ts` —
  the Eliza-side resolver that maps `ELIZA_MODEL=eliza-1-<size>` →
  `(repo, quant, backend)` per detected GPU.
