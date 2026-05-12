# Cloud-GPU one-line runner — `run-on-cloud.sh`

One command to rent a GPU, run an Eliza-1 task on it, pull the evidence back
into the repo, and tear the instance down. **It fails closed:** it will not
provision a paid instance unless you pass `--yes-i-will-pay` *and* the relevant
API-key env var is set. `--dry-run` prints the provisioning plan and spends
nothing.

This wraps existing primitives — it does not duplicate them:

| Provider | What it uses |
|---|---|
| `vast` | the `vastai` CLI (`pip install --user vastai`), `VAST_API_KEY` — implemented here for `build` / `kernel-verify` / `bench` |
| `--task train --provider vast` | delegates to [`../train_vast.sh provision-and-train`](../CLOUD_VAST.md) (its GPU mapping, checkpoint pull, teardown) |
| `--task train --provider nebius` | delegates to [`../train_nebius.sh full`](../train_nebius.sh) — H200 (`gpu-h200x1` for 0.6b/1.7b/9b, `gpu-h200x2` + FSDP for 27b); requires `NEBIUS_PROJECT_ID`. Emergency fallback; Vast is canonical. |
| `nebius` + `kernel-verify`/`bench` | not wired yet (extend `../lib/backends/nebius.py` + the `kernel-verify`/`bench` branch in `run-on-cloud.sh`) |

The existing cloud backend abstraction (`../lib/backends/base.py`,
`../cloud_run.py`) is the place to add Nebius/RunPod/Lambda for the
provision/search/status/teardown primitives; `run-on-cloud.sh` is the
task-oriented front door on top of it.

## Required env vars

| Var | Needed for | Notes |
|---|---|---|
| `VAST_API_KEY` | any vast provisioning | or run `vastai set api-key <key>` once (persists to `~/.config/vastai/vast_api_key`) |
| `SSH_PUBKEY` | any vast provisioning | path to your ssh pubkey; default `~/.ssh/id_ed25519.pub` (or `--ssh-pubkey`) |
| `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN` | `--task train` (gated dataset/model repos) | forwarded by `train_vast.sh` |
| `NEBIUS_*` | `--task train --provider nebius` (fallback) | see `../train_nebius.sh` |
| `ELIZA_DFLASH_SMOKE_MODEL` | `--task kernel-verify` graph smoke (optional) | path to a smoke GGUF; without it the runner does fixture-parity only and the emitted JSON is `passRecordable: false` (NOT a runtime-ready record) |

## Literal invocations

```bash
# Build the linux-x64-cuda-fused runtime on an H100 (llama-server +
# libelizainference + ggml-cuda kernels), ldd-self-check, emit a small
# build-evidence JSON into packages/inference/verify/build-results/.
bash packages/training/scripts/cloud/run-on-cloud.sh \
  --provider vast --task build --gpu h100 --yes-i-will-pay

# Kernel verification on an H100 — build linux-x64-cuda, cuda-verify +
# cuda-verify-fused fixture parity, then (if --smoke-model) cuda_runner.sh
# --report; pulls JSON into packages/inference/verify/hardware-results/.
bash packages/training/scripts/cloud/run-on-cloud.sh \
  --provider vast --task kernel-verify --gpu h100 --yes-i-will-pay

# Same, with a graph-smoke model so the JSON is a recordable runtime-ready record:
bash packages/training/scripts/cloud/run-on-cloud.sh \
  --provider vast --task kernel-verify --gpu h100 \
  --smoke-model /models/eliza-1-smoke.gguf --yes-i-will-pay

# CUDA e2e bench for the 0.6B tier on an RTX 4090:
bash packages/training/scripts/cloud/run-on-cloud.sh \
  --provider vast --task bench --gpu rtx4090 --tier 0_6b --yes-i-will-pay

# Train the 27B tier on 2x B200 (delegates to train_vast.sh provision-and-train):
bash packages/training/scripts/cloud/run-on-cloud.sh \
  --provider vast --task train --gpu b200 --tier 27b --yes-i-will-pay

# Train the 0.6B tier on a Nebius H200 (delegates to train_nebius.sh full):
NEBIUS_PROJECT_ID=project-… HUGGING_FACE_HUB_TOKEN=… \
bash packages/training/scripts/cloud/run-on-cloud.sh \
  --provider nebius --task train --gpu h200 --tier 0_6b --yes-i-will-pay
# Plan only (no spend):
bash packages/training/scripts/cloud/run-on-cloud.sh \
  --provider nebius --task train --gpu h200 --tier 0_6b --dry-run

# Plan only — prints what it WOULD provision, spends nothing:
bash packages/training/scripts/cloud/run-on-cloud.sh \
  --provider vast --task kernel-verify --gpu h100 --dry-run
```

## Flags

| Flag | Values | Default |
|---|---|---|
| `--provider` | `vast` \| `nebius` | (required) |
| `--task` | `build` \| `kernel-verify` \| `bench` \| `train` | (required) |
| `--gpu` | `h100` `h200` `a100` `a100-80` `rtx4090` `rtx5090` `l40s` `b200` `blackwell6000` | `h100` |
| `--tier` | `0_6b` `1_7b` `9b` `27b` `27b-256k` `27b-1m` | `0_6b` |
| `--ssh-pubkey` | path | `~/.ssh/id_ed25519.pub` |
| `--smoke-model` | path to a GGUF | none (parity-only) |
| `--yes-i-will-pay` | (gate) — required for any real provisioning | off |
| `--dry-run` | print the plan, no spend | off |

## What lands back in the repo

| Task | Output |
|---|---|
| `kernel-verify` | `packages/inference/verify/hardware-results/cuda-linux-<gpu>-<date>.json` |
| `bench` | `packages/inference/verify/bench_results/cuda_<gpu>_<tier>_<date>.json` |
| `train` | checkpoints pulled by `train_vast.sh pull-checkpoints` (see `../CLOUD_VAST.md`) |

## Teardown / safety

* The runner sets an `EXIT` trap that calls `vastai destroy instance <id>`. If
  it dies hard, the instance id is written to
  `packages/training/scripts/cloud/.run_on_cloud_instance_id` — destroy it
  manually with `vastai destroy instance "$(cat …/.run_on_cloud_instance_id)"`.
* `--dry-run` and the missing-API-key / missing-`--yes-i-will-pay` paths exit
  non-zero **before** any `vastai create`.
* Image: `nvidia/cuda:12.8.0-devel-ubuntu24.04` (12.8 toolkit → real `sm_120`
  SASS for Blackwell; harmless on Hopper/Ampere).

## When you DON'T need cloud

If this box's NVIDIA dGPU has been brought up by the operator, run the verify
locally instead — see
[`../../inference/reports/porting/2026-05-11/cuda-bringup-operator-steps.md`](../../inference/reports/porting/2026-05-11/cuda-bringup-operator-steps.md).
