# Eliza-1 GPU Tier Configuration Profiles

Simplified per-GPU configuration profiles for the Eliza-1 model family.
These profiles are produced by the loader in
[`packages/shared/src/local-inference-gpu/gpu-tier-profiles.ts`](../../packages/shared/src/local-inference-gpu/gpu-tier-profiles.ts)
and the detection utility in
[`packages/shared/src/local-inference-gpu/gpu-tier-detect.ts`](../../packages/shared/src/local-inference-gpu/gpu-tier-detect.ts).

For the richer YAML-backed per-bundle tuning system (with exact
n_gpu_layers, KV cache types, TPS estimates, and verify recipes) see
[`gpu-tier.md`](./gpu-tier.md) and the YAML files in
`packages/shared/src/local-inference-gpu/profiles/`.

## Supported GPUs

| GPU | VRAM | Compute | Primary tier | DFlash drafter | Ctx size |
|---|---|---|---|---|---|
| NVIDIA RTX 3090 | 24 GB | 8.6 | 7b-q4 | 0_6b | 32 768 tokens |
| NVIDIA RTX 4090 | 24 GB | 8.9 | 7b-q8 | 0_6b | 65 536 tokens |
| NVIDIA RTX 5090 | 32 GB | 12.0 | 14b-q8 | 1_7b | 131 072 tokens |
| NVIDIA H200 | 141 GB | 9.0 | 27b-q8 | 2b | 262 144 tokens |

**Columns:**
- **Primary tier** — the recommended model tier for this card under normal
  single-GPU workloads.
- **DFlash drafter** — the speculative-decoding companion drafter tier
  used for DFlash acceleration (see `dflash.drafter_tier` in the profile).
- **Ctx size** — maximum recommended context window in tokens.

## Auto-detection

`autoSelectProfile()` in `gpu-tier-detect.ts` follows this resolution
order (later wins):

1. If `ELIZA_GPU_PROFILE` is set → use that profile id directly (no
   nvidia-smi invocation).
2. Otherwise, run `detectNvidiaGpu()` (nvidia-smi query) and call
   `selectBestProfile(vramGb, cudaCompute)`.
3. Return `null` when no GPU is detected or no profile fits (CPU/catalog
   defaults apply).

`selectBestProfile` picks the profile with the highest `vram_gb` that
still satisfies:

- `profile.vram_gb <= detectedVramGb`
- `profile.cuda_compute <= detectedCudaCompute`

A 24 GB card at compute 8.9 selects the RTX 4090 profile rather than
the RTX 3090 profile because 8.9 > 8.6.

## Override: `ELIZA_GPU_PROFILE`

Set `ELIZA_GPU_PROFILE=<id>` to skip auto-detection and force a specific
profile. Valid ids: `rtx-3090`, `rtx-4090`, `rtx-5090`, `h200`.

```bash
# Force the RTX 4090 profile regardless of detected GPU
ELIZA_GPU_PROFILE=rtx-4090 bun run start
```

If the id is not recognised, `autoSelectProfile()` returns `null` (no
profile applied, catalog defaults used).

> **Note:** `ELIZA_GPU_PROFILE` is documented here as the canonical
> override key. Wiring it into the server spawn path
> (`dflash-server.ts`) is a separate integration step — see the patch
> docs in `gpu-overrides.ts`.

## Building llama-server flags

`buildLlamaCppArgs(profile, overrides?)` converts a profile into a
ready-to-use argv array:

```ts
import { getGpuProfile, buildLlamaCppArgs } from "@elizaos/shared/local-inference-gpu";

const profile = getGpuProfile("rtx-4090")!;
const args = buildLlamaCppArgs(profile);
// ["--n-gpu-layers", "99", "--flash-attn", "--ctx-size", "65536"]

// Override context size per-call:
const tightArgs = buildLlamaCppArgs(profile, { ctx_size_tokens: 16384 });
// ["--n-gpu-layers", "99", "--flash-attn", "--ctx-size", "16384"]
```

Flags produced (in order):

| Flag | Condition |
|---|---|
| `--n-gpu-layers <N>` | always |
| `--flash-attn` | `flash_attn: true` |
| `--no-mmap` | `use_mmap: false` |
| `--numa` | `numa: true` |
| `--ctx-size <N>` | always |

`--model <path>` is intentionally omitted — callers must append it so
this function never touches model files.

## NUMA note — H200

The H200 profile sets `numa: true`, which adds `--numa` to the
llama-server invocation. This is appropriate for SXM5 form-factor H200s
installed in multi-socket servers (typically 8-way NVLink nodes with two
or more CPU sockets).

On a single-socket workstation the `--numa` flag is harmless but
unnecessary. If deploying H200 on a single-socket host, override with:

```bash
ELIZA_GPU_PROFILE=h200  # uses profile defaults, including numa=true
```

or pass an explicit override:

```ts
buildLlamaCppArgs(profile, { numa: false });
```

## FP4 note — RTX 5090 (Blackwell)

The RTX 5090 (Blackwell, `sm_120`) is the first consumer card with
hardware FP4 tensor cores. The profile lists `"fp4"` in its `features`
array. The actual FP4 path in llama.cpp is still maturing at the time
of writing — the runtime probes `CAPABILITIES.json` (from the
buun-llama-cpp fork) before activating FP4 kernels. If the probe fails
the runtime falls back to FP8 with a structured warning.

FP4 accelerates speculative decoding (DFlash) in particular — the 5090
profile uses a larger drafter tier (`1_7b`) and a wider speculative
window (8 tokens) to take advantage of the higher throughput.
