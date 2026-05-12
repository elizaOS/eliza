# vast-pyworker — GGUF / DFlash on Vast Serverless

PyWorker that fronts a `llama.cpp` `llama-server` hosting the Q6_K GGUF of
[`elizaos/eliza-1-27b-fp8`][1]
on a single RTX 5090 worker. Deployed by Vast.ai Serverless; the template
defines the image and the on-start script, both committed in this repo.
The same worker can serve Eliza-1/3.6 DFlash target+drafter pairs when the
template image provides a DFlash-capable `llama-server` fork.

[1]: https://huggingface.co/elizaos/eliza-1-27b-fp8

## Why GGUF + llama.cpp (not vLLM)

The default served file is a Q6_K GGUF (22.4 GB on disk, ~24 GB resident
including KV cache at 32k context with `--parallel 2`). vLLM's GGUF support
is experimental and slow; `llama-server` is the native, well-tuned path for
k-quants on consumer Blackwell GPUs and exposes the same OpenAI-compatible
endpoints (`/v1/chat/completions`, `/v1/completions`, `/v1/models`) that the
PyWorker proxies through.

GPU sizing (RTX 5090, 32 GB VRAM):

| context | parallel | weights | KV cache | resident | headroom |
|---------|---------:|--------:|---------:|---------:|---------:|
| 32k     | 2        | 22.4 GB | ~2 GB    | ~25 GB   | ~7 GB    |
| 32k     | 4        | 22.4 GB | ~4 GB    | ~27 GB   | ~5 GB    |
| 65k     | 2        | 22.4 GB | ~4 GB    | ~27 GB   | ~5 GB    |

Default config: `LLAMA_CONTEXT=32768`, `LLAMA_PARALLEL=2`. Tune via the
template env if a workload needs longer context or more concurrent decode
slots.

## Files

| path | purpose |
|------|---------|
| `worker.py` | PyWorker process; tails `llama-server` log for readiness, registers handlers, reports per-request workload to the Vast Serverless Engine. |
| `onstart.sh` | Inline `on_start` script for the Vast template. Clones the repo, downloads the GGUF, launches `llama-server`, exec's `worker.py`. Idempotent — reruns reuse the cached weight file. |
| `onstart-vllm.sh` | vLLM flavor for safetensors/AWQ/FP8 deployments. Reads a manifest, launches `vllm serve`, then execs the same PyWorker. |
| `manifests/` | Cloud-owned Vast manifests for `vast/eliza-1-{2b,9b,27b}`. These mirror the model catalog and are embedded into vLLM templates by `upsert-template.ts`. |
| `requirements.txt` | Python deps for `worker.py`. The image already provides `llama-server` and CUDA. |

## How Vast deploys this

A Vast template (managed by `cloud/scripts/vast/upsert-template.ts`) declares:

- `image = ghcr.io/ggml-org/llama.cpp:server-cuda` for stock GGUF. DFlash and
  TurboQuant KV-cache flags require a fork image, for example one built from
  `spiritbuun/buun-llama-cpp`, and can be selected with `VAST_IMAGE` plus
  `LLAMA_SERVER_BIN`.
- `disk = 60 GB` (room for the GGUF + HF cache + a swap-in alternate quant).
- `onstart = <inline contents of onstart.sh>`.
- `env = { PYWORKER_REPO, PYWORKER_REF, MODEL_REPO, MODEL_FILE, MODEL_ALIAS,
  LLAMA_CONTEXT, LLAMA_PARALLEL, LLAMA_NGL, DFLASH_DRAFTER_REPO,
  DFLASH_DRAFTER_FILE, LLAMA_CACHE_TYPE_K, LLAMA_CACHE_TYPE_V }` — all
  overridable per-template.

On every cold start the on-start script:

1. Clones `PYWORKER_REPO` at `PYWORKER_REF` into `/workspace/pyworker`.
2. `pip install -r services/vast-pyworker/requirements.txt`.
3. Downloads `MODEL_REPO/MODEL_FILE` into `/workspace/models` (skip if cached).
4. Launches `llama-server --alias "$MODEL_ALIAS" --port 8080 …` in the
   background, redirecting to `/var/log/llama-server.log`.
5. `exec`s `python3 worker.py`. The worker tails the log for the
   `server is listening` line, then routes traffic.

## Endpoint scaling

Vast manages the queue, load balancer, and autoscaler. Configure the endpoint
via `cloud/scripts/vast/provision-endpoint.ts`:

- Endpoint autoscaling defaults: `min_load=1`, `cold_workers=1`,
  `max_workers=8`, `target_util=0.85`, `cold_mult=2.5`.
- Worker hardware comes from the selected manifest, not from hardcoded defaults.
  For example, the 27B manifest requests 2 GPUs, roughly 176 GiB VRAM,
  120 GiB disk, 500 Mbps ingress, verified hosts, and H200/B200-class GPUs.
- Override controls with `VAST_MIN_LOAD`, `VAST_COLD_WORKERS`,
  `VAST_MAX_WORKERS`, `VAST_TARGET_UTIL`, `VAST_GPU_RAM_GB`, or
  `VAST_SEARCH_PARAMS` only for a measured staging experiment.

## End-to-end provisioning

```bash
# 1. (one-time) Upsert the Vast template. Captures image + onstart + env.
VASTAI_API_KEY=vastai_… \
PYWORKER_REPO=https://github.com/elizaOS/cloud.git \
PYWORKER_REF=<commit-sha> \
bun cloud/scripts/vast/upsert-template.ts
# → prints VAST_TEMPLATE_ID=<n>

# 2. Provision the endpoint + workergroup from the same manifest.
VASTAI_API_KEY=vastai_… \
VAST_TEMPLATE_ID=<n> \
ELIZA_VAST_MANIFEST=eliza-1-27b.json \
bun cloud/scripts/vast/provision-endpoint.ts

# 3. Smoke the live endpoint.
VAST_BASE_URL=https://openai.vast.ai/eliza-cloud-eliza-1-27b \
VAST_API_KEY=<endpoint-token> \
VAST_MODEL=eliza-1-27b \
bun run --cwd cloud vast:smoke

# 4. Wire the cloud Worker to forward to the endpoint.
wrangler secret put VAST_BASE_URL_ELIZA_1_27B
wrangler secret put VAST_API_KEY     # endpoint-specific token, NOT the CLI key
```

## DFlash Template

Use a fork image that understands `--spec-type dflash`, then set the target
and drafter artifacts:

```bash
# Build/push once. Use --build-arg BASE_IMAGE=rocm/dev-ubuntu-22.04:6.3
# --build-arg BACKEND=rocm for AMD hosts.
docker build -f cloud/services/vast-pyworker/Dockerfile.dflash \
  --build-arg BACKEND=cuda \
  -t ghcr.io/YOUR_ORG/buun-llama-cpp:cuda-dflash .
docker push ghcr.io/YOUR_ORG/buun-llama-cpp:cuda-dflash

VAST_TEMPLATE_NAME=eliza-cloud-eliza-1-27b \
VAST_IMAGE=ghcr.io/YOUR_ORG/buun-llama-cpp:cuda-dflash \
MODEL_REPO=elizaos/eliza-1-27b-gguf-q4_k_m \
MODEL_FILE=text/eliza-1-pro-27b-128k.gguf \
MODEL_ALIAS=vast/eliza-1-27b \
DFLASH_DRAFTER_REPO=spiritbuun/Eliza-1-27B-DFlash-GGUF \
DFLASH_DRAFTER_FILE=dflash-draft-3.6-q8_0.gguf \
LLAMA_CONTEXT=8192 \
LLAMA_DRAFT_CONTEXT=256 \
LLAMA_DRAFT_MAX=16 \
bun cloud/scripts/vast/upsert-template.ts
```

For smaller tiers, use the canonical `elizaos/eliza-1-*` GGUF repos as the
target repo and the corresponding Eliza-1 DFlash drafter. Those drafters are
repaired on startup
when they are missing `tokenizer.ggml.merges`; bundle llama.cpp's `gguf-py`
next to `llama-server` or set `GGUF_PYTHONPATH` in the template image.
`LLAMA_CACHE_TYPE_K/V` can be set for TurboQuant-capable forks; stock upstream
images will reject those cache types.
The worker also disables thinking mode with
`--chat-template-kwargs '{"enable_thinking":false}'`; the DFlash drafter was
not trained on think-wrapped text and acceptance/throughput collapse when it is
left on.

## vLLM Manifests

Set `VAST_RUNTIME=vllm` to make `upsert-template.ts` inline
`onstart-vllm.sh` instead of the GGUF `llama-server` script. The script embeds
the selected manifest JSON into the Vast template, so workers do not depend on
training-repo paths at cold start.

```bash
VAST_RUNTIME=vllm \
ELIZA_VAST_MANIFEST=eliza-1-27b.json \
VAST_TEMPLATE_NAME=eliza-cloud-eliza-1-27b-vllm \
PYWORKER_REF=<commit-sha> \
bun cloud/scripts/vast/upsert-template.ts
```

The committed manifests cover the catalog references:

- `eliza-1-2b.json`: vLLM 2B debug tier, AWQ-Marlin field present, KV cache left
  on `auto`.
- `eliza-1-9b.json`: `elizaos/eliza-1-9b-polarquant` with AWQ-Marlin and the
  TurboQuant quality KV preset.
- `eliza-1-27b.json`: `elizaos/eliza-1-27b-fp8` with FP8 weights and the
  TurboQuant quality KV preset.

TurboQuant is opt-in by env when a manifest does not set it:
`VLLM_ENABLE_TURBOQUANT=1` uses `VLLM_TURBOQUANT_PRESET=quality`, which maps to
vLLM's `turboquant_k8v4` preset. Use `VLLM_TURBOQUANT_PRESET=4bit` or
`KV_CACHE_DTYPE=turboquant_4bit_nc` only after a regression run.

vLLM speculative decoding can be enabled with either raw
`SPECULATIVE_CONFIG_JSON` or DFlash helpers:

```bash
DFLASH_MODEL=org/model-dflash \
ELIZA_VLLM_DFLASH=1 \
SPECULATIVE_TOKENS=15 \
DRAFT_TENSOR_PARALLEL_SIZE=1 \
bun cloud/scripts/vast/upsert-template.ts
```

For Apple Silicon/vllm-metal images, pass `VLLM_METAL_ADDITIONAL_CONFIG_JSON`.
If `VLLM_ENABLE_METAL_TURBOQUANT=1`, the script also exports
`VLLM_METAL_USE_PAGED_ATTENTION=1` and maps the quality preset to
`{"turboquant":true,"k_quant":"q8_0","v_quant":"q3_0"}`.

QJL is not enabled by any manifest. To run a benchmark-only experiment, set
`VLLM_EXPERIMENTAL_QJL=1` and `VLLM_QJL_BENCHMARK_GATE=passed`; otherwise the
startup script exits before launching vLLM.

Run the cloud-side validation before changing a template:

```bash
cd cloud
bun run vast:doctor
```

## Routing from eliza/cloud

The cloud Worker routes `vast/eliza-1-*` requests through `VastProvider`
(`packages/lib/providers/vast.ts`). Prefer one endpoint per model tier:

- `VAST_BASE_URL_ELIZA_1_2B`
- `VAST_BASE_URL_ELIZA_1_9B`
- `VAST_BASE_URL_ELIZA_1_27B`

All can share `VAST_API_KEY`, or a tier can use `VAST_API_KEY_ELIZA_1_27B`.
`VAST_API_MODEL_ELIZA_1_27B` overrides the model id sent upstream; by default
the provider sends the vLLM served name (`eliza-1-27b`) for
`vast/eliza-1-27b`. `VAST_BASE_URL` remains as a global compatibility fallback
but should not be used for production multi-tier routing.

When 27B and 9B have dedicated endpoint URLs, provider fallback can route
retryable 5xx/timeout/capacity errors from 27B to 9B, and from 9B to 2B.

## Swapping in a fine-tuned model

After the training pipeline (`/training/scripts/train_nebius.sh` or vast)
emits a checkpoint and pushes it to HF as a GGUF (e.g.
`elizaos/eliza-1-27b-eliza-v0.1-gguf`):

1. Update the Vast template's `MODEL_REPO` / `MODEL_FILE` env (re-run
   `upsert-template.ts` with the new env, or change in the Vast UI).
2. Optionally change `MODEL_ALIAS` to `vast/eliza-1-27b-eliza-v0.1` and add
   the matching catalog entry in `cloud/packages/lib/models/catalog.ts`.
3. Vast cycles workers automatically once the template is updated; the next
   cold-start downloads the new GGUF on first run, then caches it on the
   worker volume.
