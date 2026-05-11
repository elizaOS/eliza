# Eliza-1 vast-pyworker manifests

One JSON manifest per published Eliza-1 size. Each describes the Vast.ai
worker shape (image, GPU class, disk, ports) and the canonical
`vllm serve` argv (mirroring the per-target defaults from
`training/scripts/inference/serve_vllm.py`).

| Manifest | GPU target (in `serve_vllm.py`) | Approx. disk | Recommended cards |
|----------|----------------------------------|-------------:|-------------------|
| `eliza-1-2b.json`  | `single`   | 30 GB  | RTX 4090 / 5090 / RTX Pro 5000 / L40S |
| `eliza-1-9b.json`  | `h100-2x`  | 60 GB  | 2x H100 PCIe / H100 SXM / H200 SXM / H200 NVL |
| `eliza-1-27b.json` | `h200-2x`  | 120 GB | 2x H200 SXM / NVL, 2x B200 SXM |

The manifests are deliberately *parallel* to `serve_vllm.py`'s
`GPU_TARGETS` table so the same canonical args ship in both paths.
When the underlying registry / vLLM args drift, regenerate by hand from
`training/scripts/inference/serve_vllm.py --registry-key <key>
--gpu-target <target> --dry-run`.

> **Worker contract — read before launching.** The upstream pyworker at
> `eliza/cloud/services/vast-pyworker/{worker.py,onstart.sh}` is
> hardcoded to a llama-server (GGUF) backend on **port 8080**. These
> manifests serve **vLLM on port 8000**. The sibling
> `onstart-vllm.sh` in this directory bridges that gap: it reads the
> per-size manifest's `vllm_args` + `vast_template_env`, launches
> `vllm serve`, tails the log for `Application startup complete`, and
> then `exec`s the upstream `worker.py` with `LLAMA_SERVER_PORT` and
> `LLAMA_SERVER_LOG` pointed at the vLLM endpoint. The pyworker code
> stays unchanged — only the launch-and-tail step is swapped.
>
> Two deploy paths:
>
> 1. **vLLM (default for this directory)** — point the Vast template at
>    `cloud/vast-pyworker/onstart-vllm.sh` and set
>    `vast_template_env.{MODEL_REPO,MODEL_ALIAS,VLLM_PORT,VLLM_REGISTRY_KEY}`.
>    Each manifest declares the script via the `onstart_script` field.
> 2. **GGUF/llama-server (legacy)** — point a Vast template at
>    `MODEL_REPO=elizalabs/eliza-1-<size>-gguf-q4_k_m` (or `-gguf-q6_k`)
>    plus the upstream `onstart.sh`. That matches the pyworker
>    contract without any wrapper, and is what
>    `eliza/cloud/scripts/vast/upsert-template.ts` does for the 27B
>    NEO-CODE deploy.

## Launching with the Vast CLI

There is no `vastai launch instance` subcommand in the official CLI as of
this writing. The actual flow is:

1. **One-time per size**: register a Vast template that points at the
   pyworker `onstart.sh` and embeds the per-size env. The existing
   `eliza/cloud/scripts/vast/upsert-template.ts` script handles this for
   the 27B GGUF/llama-server path; clone it per size to upsert the
   vLLM-based templates.
2. **Per-deploy**: launch an instance against the template via
   `vastai create instance <id> --template_hash <hash> --label
   eliza-1-<size>`. Vast picks an offer that matches the template's
   `search_params` (mirrored verbatim into each manifest above).

For autoscaled deployment (recommended for prod), provision a Vast
Serverless endpoint that owns the template:

```bash
# 1. Upsert the template (once per size/quant combo).
VASTAI_API_KEY=vastai_… \
VAST_TEMPLATE_NAME=eliza-cloud-eliza-1-9b-vllm \
PYWORKER_REPO=https://github.com/elizaOS/cloud.git \
PYWORKER_REF=<commit-sha> \
MODEL_REPO=elizalabs/eliza-1-9b-polarquant \
MODEL_ALIAS=vast/eliza-1-9b \
bun eliza/cloud/scripts/vast/upsert-template.ts
# → prints VAST_TEMPLATE_ID=<n>

# 2. Provision the autoscaled endpoint.
VASTAI_API_KEY=vastai_… VAST_TEMPLATE_ID=<n> \
bun eliza/cloud/scripts/vast/provision-endpoint.ts
```

The `eliza/cloud/services/vast-pyworker/` pyworker code itself is
unchanged — it tails its `LLAMA_SERVER_LOG` for readiness regardless
of the underlying engine. The sibling `onstart-vllm.sh` in this
directory drives the vLLM path: it pulls the manifest, launches
`vllm serve` with the manifest's `vllm_args`, tails for
`Application startup complete`, and then `exec`s the pyworker with
`LLAMA_SERVER_PORT=$VLLM_PORT` and `LLAMA_SERVER_LOG=/var/log/vllm-server.log`
so the heartbeat handlers wire up to the vLLM endpoint.

### `onstart-vllm.sh` quick reference

Required env (sourced from the manifest's `vast_template_env` block):

| Var               | Meaning                                              |
|-------------------|------------------------------------------------------|
| `MODEL_REPO`      | HuggingFace repo id (e.g. `elizalabs/eliza-1-9b`).     |
| `MODEL_ALIAS`     | Display alias the pyworker reports (e.g. `vast/eliza-1-9b`). |
| `VLLM_PORT`       | Port vLLM binds to (must match the manifest `port`). |
| `VLLM_REGISTRY_KEY` | Training-side key, used for log lines + manifest auto-resolve. |

Optional env: `MILADY_VAST_MANIFEST` (override manifest path), `HUGGING_FACE_HUB_TOKEN`,
`PYWORKER_REPO`, `PYWORKER_REF`, `MODEL_DIR`, `PYWORKER_DIR`, `VLLM_LOG`,
`VLLM_READY_TIMEOUT`. See the script header for full defaults.

The script is idempotent (re-runs detect a live `/health` on `$VLLM_PORT`
and skip relaunch) and writes to `/var/log/vllm-server.log` so Vast template
log tailing works.

## Manual single-instance smoke test

Pick an offer manually:

```bash
# Find a 2x H200 box.
vastai search offers 'gpu_name=H200_SXM num_gpus>=2 reliability>=0.95 verified=true' \
  --order 'dph+' --limit 5

# Launch using one of the offer IDs.
vastai create instance <offer-id> \
  --image vllm/vllm-openai:v0.20.1 \
  --disk 120 \
  --label eliza-1-27b \
  --env '-p 8000:8000 -e MODEL_REPO=elizalabs/eliza-1-27b-fp8 -e MODEL_ALIAS=vast/eliza-1-27b -e VLLM_PORT=8000 -e VLLM_REGISTRY_KEY=eliza-1-27b' \
  --onstart-cmd "$(cat onstart-vllm.sh)"

# Get the public endpoint.
vastai show instance <instance-id>
# → forward 8000 → http://<public-ip>:<mapped-port>/v1
```

`vllm/vllm-openai:v0.20.1` is the image pin used in the canonical
serve script header. Bump the tag in lockstep with that file.

## Routing from Eliza Cloud

The cloud Worker expects model IDs like `vast/eliza-1-9b` to forward
through `eliza/cloud/packages/lib/providers/vast.ts`. Adding a new
size to the cloud catalog requires one new entry in
`eliza/cloud/packages/lib/models/catalog.ts` per Vast alias —
structurally identical to the existing `vast/eliza-1-27b`
row. See `../README.md` for the integration overview.
