# Vast.ai operator runbook (eliza-1)

Vast.ai is the **canonical active** cloud for eliza-1 training and inference.
Nebius is deprecated and is retained only as an emergency fallback.

`train_vast.sh` will refuse to run if any `NEBIUS_*` env var is set — that
prevents stale `.env` files from cross-contaminating runs. If you genuinely
need the Nebius emergency fallback, invoke `train_nebius.sh` directly.

Commands below assume the pipeline root as the working directory:
`packages/training` in a monorepo checkout, or `training` after downloading
`elizaos/eliza-1-pipeline`.

---

## First-time setup

1. Install the Vast CLI:

   ```bash
   pip install --user vastai
   vastai --version
   ```

2. Set your API key. Either export it once per shell, or persist it:

   ```bash
   export VAST_API_KEY=<your-key>           # ephemeral
   vastai set api-key <your-key>            # persists to ~/.config/vastai/vast_api_key
   ```

3. Make sure your SSH key exists. `train_vast.sh` defaults to
   `~/.ssh/id_ed25519.pub`; override with `SSH_KEY=<path>` if you use a
   different one.

4. Set your HuggingFace token for gated repos:

   ```bash
   export HUGGING_FACE_HUB_TOKEN=<hf-token>
   ```

5. (Optional) Set the canonical env names:

   ```bash
   export MILADY_VAST_GPU_PREFERENCE="B200,H200,H100,RTX5090"
   export MILADY_VAST_DISK_GB=200            # aliases VAST_DISK_GB
   ```

   `MILADY_VAST_GPU_PREFERENCE` is csv. The first match wins. Override
   `VAST_GPU_TARGET` directly if you need fine-grained control
   (e.g. `b200-2x`, `h200-1x`, `blackwell6000-1x`).

---

## Train a new model

The canonical entrypoint is `provision-and-train`, which chains
provision -> sync -> run in one command. Each invocation creates a fresh
instance unless `.vast_instance_id` already points at a live one (set
`FORCE_REPROVISION=1` to override).

| Size | Command | Default GPU | Wall (1B tokens) | Cost |
|------|---------|-------------|------------------|------|
| 2B   | `bash scripts/train_vast.sh provision-and-train --registry-key qwen3.5-2b --epochs 1` | 1x Blackwell 6000 (96 GB) | ~31 h | ~$41 |
| 9B   | `bash scripts/train_vast.sh provision-and-train --registry-key qwen3.5-9b --epochs 1` | 1x Blackwell 6000 (96 GB) | ~139 h | ~$186 |
| 27B  | `bash scripts/train_vast.sh provision-and-train --registry-key qwen3.6-27b --epochs 1` | 2x B200 (366 GB) | ~33 h | ~$253 |

Faster alternatives are documented in the script header (e.g. 9B on 2x B200
is ~11 h / ~$84). Override the GPU target with
`VAST_GPU_TARGET=b200-2x bash ... provision-and-train ...`.

### Training split contract

Remote training uses the same root split names as local training:

```text
data/final/train.jsonl
data/final/val.jsonl
data/final/test.jsonl
```

`sync` copies only those active root files plus the final manifest/README.
`bootstrap-from-hf` downloads the same names to `/workspace/training/data/final/`.
Candidate directories use `data/validation.jsonl`; promote or copy that split
to `data/final/val.jsonl` before starting a Vast run.

`train_local.py` accepts `eliza_native_v1`, trainable
`eliza.eliza1_trajectory_record.v1` message rows, already-rendered chat-message
rows with a final assistant turn, and legacy flat `ElizaRecord` rows. It
rejects `repair_eval` and failed-quality rows.

After provisioning, save the instance id for later commands:

```bash
export MILADY_VAST_INSTANCE_ID=$(cat .vast_instance_id)
```

(`train_vast.sh` reads `.vast_instance_id` automatically; the export just
makes it available to other tools and to the watcher.)

### Watch the run

In a separate shell, start the liveness watcher:

```bash
bash scripts/vast-watcher.sh &
```

The watcher polls `train_vast.sh status` every 60 s and writes incident
reports to `~/.milady/vast-incidents/<timestamp>.log` after 3 consecutive
failed polls. It does **not** auto-reprovision — that is a money decision.
Logs land at `~/.milady/vast-watcher.log` (rotated at 10 MB).

Tail training output directly:

```bash
bash scripts/train_vast.sh tail-logs
```

---

## Pull checkpoints during training

Cron-style snippet — pull only the latest checkpoint every 30 min so you
have something to evaluate or fall back to if the instance dies:

```cron
*/30 * * * * cd /home/shaw/milady/training && bash scripts/train_vast.sh pull-checkpoints --latest-only >> ~/.milady/vast-pull.log 2>&1
```

To pull every checkpoint (slower, more bandwidth, complete history):

```bash
bash scripts/train_vast.sh pull-checkpoints
```

`CheckpointSyncAgent` owns the periodic-pull loop with eval gating
(`scripts/checkpoint_sync_loop.sh`); the manual `pull-checkpoints`
subcommand is the underlying primitive both that loop and the cron snippet
above use.

---

## Serve a trained model

Inference uses `eliza/cloud/services/vast-pyworker/onstart-vllm.sh` as the
Vast template `on_start`. The script reads `MILADY_VAST_MANIFEST` to pick
flags from one of:

- `eliza-1-2b.json` — 1x RTX 5090 / Blackwell, AWQ-Marlin weights, bf16 KV.
- `eliza-1-9b.json` — 1x H200, FP8 weights, FP8 KV.
- `eliza-1-27b.json` — 2x B200, FP8 weights, FP8 KV, EP=2.

Set the template env on the Vast instance (or pass via `vastai create`):

```bash
MILADY_VAST_MANIFEST=eliza-1-9b.json
HUGGING_FACE_HUB_TOKEN=<token>
```

The manifest's `model`, `tensor_parallel_size`, `expert_parallel_size`,
`max_model_len`, `gpu_memory_utilization`, `weight_quantization`,
`kv_cache_dtype`, `tool_parser`, and `reasoning_parser` flow into
`vllm serve` automatically. Caller-supplied envs always win over manifest
values, so you can override one field without forking the manifest.

Stats are written every 60 s to `~/.cache/vllm-stats.jsonl` (tokens/s,
KV bytes/token placeholder, GPU cache usage). The richer
`InferenceObservabilityAgent` heartbeat lands at
`/workspace/inference-stats.jsonl` for the Eliza Cloud UI.

---

## Tear down everything

Graceful (recommended):

```bash
bash scripts/train_vast.sh kill-and-teardown --yes
```

This sends `SIGTERM` to `accelerate launch` and `train_local.py`, waits
60 s, sends `SIGKILL` to anything still alive, and then destroys the
instance. Use this when you need to stop a run cleanly so checkpoints land
on disk before destruction.

Immediate (skips graceful shutdown):

```bash
bash scripts/train_vast.sh teardown --yes
```

Both subcommands require `--yes` (or `CONFIRM_TEARDOWN=1`) to actually
destroy. Without confirmation they print a refusal and exit nonzero.

After teardown, `.vast_instance_id` is removed and the watcher will start
emitting incidents on its next poll — kill the watcher with `kill %1` (or
whatever job number) once you're done.

---

## Nebius migration

`train_nebius.sh` is kept on disk as an emergency fallback only. **Do not
extend it. Do not add new Nebius features. Do not present Nebius as a normal
operator path.** All new training and inference work goes through
`train_vast.sh` and the Vast PyWorker template. The Nebius script stays in the
tree solely so an operator can recover capacity if Vast is fully unavailable
for an extended outage; even then, prefer waiting on Vast over building
anything new on Nebius.

Anything previously documented as a Nebius workflow (the
`provision/sync/run/quantize/bench/fetch/teardown` lifecycle, the
`NEBIUS_VM_PRESET` env, the `NEBIUS_PROJECT_ID` setup) has a one-to-one
counterpart on Vast — see the script header in `train_vast.sh` for the
mapping.

---

## Bootstrap from HuggingFace (no local rsync)

Once `elizaos/eliza-1-pipeline` and `elizaos/eliza-1-training` are
published to the Hub (see `HF_PUBLISHING.md`), a fresh Vast box can
bootstrap itself end-to-end without rsync from your local machine. This
matters when the local box is offline, lives behind a flaky home upload,
or you want a clean reproduce-from-public-state run.

### One-shot

```bash
bash scripts/train_vast.sh provision-and-train \
    --registry-key qwen3.5-9b --epochs 1 --bootstrap hf
```

`--bootstrap hf` swaps the local rsync for two `hf download`
calls on the remote: the pipeline repo lands at `/workspace/training/`
and the active dataset subset (`train.jsonl`, `val.jsonl`, `test.jsonl`,
`manifest.json`) lands at `/workspace/training/data/final/`.

### Step by step

```bash
bash scripts/train_vast.sh provision
bash scripts/train_vast.sh bootstrap-from-hf       # remote download + uv sync
bash scripts/train_vast.sh run                     # full SFT
```

### Override the source repos

```bash
bash scripts/train_vast.sh bootstrap-from-hf \
    --pipeline-repo elizaos/eliza-1-pipeline \
    --data-repo elizaos/eliza-1-training
```

The remote auto-installs `uv` and `huggingface_hub[cli]` if missing. Your
local `HF_TOKEN` / `HUGGINGFACE_HUB_TOKEN` is forwarded to the remote
shell over ssh and never echoed.

The default flow remains `--bootstrap rsync` so existing muscle memory is
preserved.
