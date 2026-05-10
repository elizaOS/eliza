# HuggingFace publishing — operator runbook

The eliza-1 training data and pipeline live on HuggingFace so a fresh
Vast.ai box can bootstrap itself without an rsync hand-off from your local
machine. This document is the operational runbook.

---

## Eliza-1 bundle publish (orchestrator)

Eliza-1 device-tier bundles ship to `elizaos/eliza-1-<tier>`. The
canonical entry point is the publish orchestrator:

```bash
python -m scripts.publish.orchestrator \
    --tier desktop-9b \
    --bundle-dir ./bundles/desktop-9b \
    --metal-verification ./reports/desktop-9b/metal_verify.json \
    --dry-run
```

`scripts/publish_all_eliza1.sh` is a thin wrapper that walks the tier
matrix and dispatches one orchestrator invocation per tier. There is no
continue-on-error behavior — any tier that fails any stage aborts the
whole run.

### Stages

The orchestrator runs six stages in order. Any failure exits non-zero
with a specific code (see "Exit codes" below):

1. **Layout validation.** Confirms the bundle directory matches
   `packages/inference/AGENTS.md` §2 (text/, tts/, asr/, vision/,
   dflash/, cache/, evals/, licenses/) and that every required license
   blob exists and is non-empty.
2. **Kernel verification.** Runs `make -C ../../inference/verify
   reference-test` for the CPU path. For Vulkan and CUDA, the
   orchestrator consumes recorded reports at
   `<bundle>/evals/vulkan_verify.json` and
   `<bundle>/evals/cuda_verify.json`. **Metal is hardware-only**: pass
   `--metal-verification PATH` pointing at a `metal_verify.json`
   recorded on a verified Metal host. Without it, a tier that includes
   Metal in `SUPPORTED_BACKENDS_BY_TIER` fails with
   `EXIT_KERNEL_VERIFY_FAIL`.
3. **Eval gates.** Loads `<bundle>/evals/aggregate.json` and applies
   `apply_gates(results, tier)` from
   `packages/training/benchmarks/eliza1_gates.py`. Refuses to proceed
   unless `passed: true`. The gate report is written into the manifest's
   `evals` block.
4. **Manifest build.** Calls `build_manifest(...)` from
   `packages/training/scripts/manifest/eliza1_manifest.py`. The manifest
   module's validator independently re-checks the §3 / §6 contract
   (every required kernel declared, every supported backend `pass`,
   every eval flag `passed`). The orchestrator sets `defaultEligible:
   true` only when every required gate is green AND every supported
   backend verified pass; the validator rejects mis-uses of that flag.
5. **README render.** Renders
   `scripts/publish/templates/README.md.j2` from the manifest data.
   No marketing copy. User-visible text stays Eliza-1-first; upstream
   lineage is recorded only in the manifest's `lineage` block.
6. **HF push + git tag.** Uploads weights, manifest, README, licenses,
   and eval blobs to `elizaos/eliza-1-<tier>` via
   `huggingface_hub.HfApi.create_commit`, then tags the local training
   repo with `eliza-1-<tier>-v<version>`. In `--dry-run` neither side
   effect happens; the would-be commands are logged.

### Assembling a bundle directory

Per `packages/inference/AGENTS.md` §2 the bundle root must look like:

```
<bundle>/
  text/      <one or more *.gguf, named eliza-1-<tier>-<ctx>.gguf>
  tts/       <omnivoice-*.gguf and tokenizer>
  asr/       <asr.gguf or native package>
  vision/    <mmproj-<tier>.gguf where applicable>
  dflash/    <drafter-<tier>.gguf and target-meta.json>
  cache/     <voice-preset-default.bin>
  evals/
    aggregate.json        # input to apply_gates(); shape per eliza1_gates.py docstring
    vulkan_verify.json    # recorded report (status, atCommit, report)
    cuda_verify.json      # recorded report (server / desktop / pro tiers)
  licenses/
    LICENSE.text
    LICENSE.voice
    LICENSE.dflash
    LICENSE.eliza-1
  lineage.json   # optional: per-slot {base, license} overrides
  ram_budget.json # optional: {min, recommended} in MB
  VERSION        # optional: bundle version (default 1.0.0)
```

The text variants encode their context length in the filename (e.g.
`eliza-1-desktop-9b-64k.gguf` → `ctx=65536`). Variants with `ctx > 64k`
automatically force `turbo3_tcq` into `kernels.optional`.

### Recording Metal verification on a hardware host

```bash
# On an Apple Silicon Mac with the milady checkout:
cd packages/inference/verify
make metal
./metal_verify > metal_verify.txt

# Then write a JSON record the orchestrator can consume:
cat > /path/to/desktop-9b/evals/metal_verify.json <<EOF
{
  "backend": "metal",
  "status": "pass",
  "atCommit": "$(git -C ../../.. rev-parse --short HEAD)",
  "report": "metal_verify.txt"
}
EOF
```

Pass that file to the orchestrator via `--metal-verification` (or via
`--metal-verification-<tier>` on the wrapper script). The orchestrator
verifies `backend == "metal"`, `status == "pass"`, and that `atCommit`
is set; anything else exits `EXIT_KERNEL_VERIFY_FAIL`.

### Exit codes

| Code | Symbol                       | Meaning                                                                 |
|-----:|------------------------------|-------------------------------------------------------------------------|
|   0  | `EXIT_OK`                    | All stages succeeded.                                                   |
|   2  | `EXIT_USAGE`                 | Argparse rejected the CLI invocation.                                   |
|  10  | `EXIT_BUNDLE_LAYOUT_FAIL`    | Bundle dir missing or required subdir absent.                           |
|  11  | `EXIT_MISSING_FILE`          | Required license blob, sidecar, or `evals/aggregate.json` missing.      |
|  12  | `EXIT_KERNEL_VERIFY_FAIL`    | `make reference-test` failed, or a recorded backend report is fail/missing/mismatched (incl. missing `--metal-verification`). |
|  13  | `EXIT_EVAL_GATE_FAIL`        | One or more required-for-tier gates in `eliza1_gates.yaml` failed.      |
|  14  | `EXIT_MANIFEST_INVALID`      | `build_manifest` rejected the assembled manifest.                       |
|  15  | `EXIT_HF_PUSH_FAIL`          | Missing `HF_TOKEN`, HF API error, or `git tag` failure.                 |

### Recovering from a partial publish

The publish flow writes the manifest + README into the bundle dir
*before* uploading. If `EXIT_HF_PUSH_FAIL` lands after the HF
`create_commit` but before `git tag`, the HF repo is consistent and the
local repo is missing only the tag. To recover:

1. Confirm the upload at `https://huggingface.co/elizaos/eliza-1-<tier>`
   — every file from `_build_upload_list` plus `README.md` and
   `eliza-1.manifest.json` should be present.
2. Re-tag manually:
   ```bash
   git -C packages/training tag -a eliza-1-<tier>-v<version> \
       -m "Publish eliza-1-<tier>-v<version> (training-commit=$(git -C packages/training rev-parse --short HEAD))"
   ```
3. Push the tag if the team workflow requires it.

If the failure was earlier (e.g. layout, eval gate, manifest), no
remote state changed — fix the bundle dir or the eval blob and re-run.
The orchestrator is idempotent on its own outputs (manifest + README are
overwritten in place each run).

### Refusing to bypass

Operators sometimes ask "can we publish anyway with `defaultEligible:
false`?" The answer is no during normal release. `defaultEligible:
false` exists for automated downgrades of a *previously-good* bundle
that has since been flagged broken — the act of *first publishing*
always requires every gate green and every supported backend verified
pass. Any flag that proposed otherwise (e.g. `--skip-eval`,
`--publish-anyway`) would violate `packages/training/AGENTS.md` §6 and
is intentionally absent.

---

## Legacy publishers (datasets + training pipeline)

## What's on HF today

| Local path                                   | HF repo                              | Type    | Status  |
|----------------------------------------------|--------------------------------------|---------|---------|
| `data/final/{train_final,val,test}.jsonl`    | `elizaos/eliza-1-training`           | dataset | PENDING |
| `data/normalized/scambench.jsonl` + synth    | `elizaos/eliza-1-scambench`          | dataset | PENDING |
| `data/synthesized/{actions,prompts}/*.jsonl` | `elizaos/eliza-1-synthesized`        | dataset | PENDING |
| `scripts/`, `pyproject.toml`, docs           | `elizaos/eliza-1-pipeline`           | model   | PENDING |
| (pointer only — uses upstream)               | `mlabonne/harmless_alpaca`           | dataset | upstream |

Update the Status column to `published` once each repo lands.

## First-time HF setup

```bash
# Either log in interactively (writes ~/.cache/huggingface/token)
hf auth login

# Or export the token in the current shell
export HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxxx
# (HUGGINGFACE_HUB_TOKEN is also accepted)
```

The publishing scripts refuse to push without one of those set.

## Publish the training dataset

```bash
cd training

# Always preview first.
uv run python scripts/publish_dataset_to_hf.py \
    --dataset training --repo-id elizaos/eliza-1-training --dry-run

# Real upload.
HF_TOKEN=hf_xxx uv run python scripts/publish_dataset_to_hf.py \
    --dataset training --repo-id elizaos/eliza-1-training
```

Expected payload: ~12.4 GB (4 files: train ~11.7 GB, val ~456 MB, test ~201
MB, manifest <1 KB). On a 50 Mbit/s home upload this is ~33 minutes; on a
gigabit fiber connection ~3 minutes. The script is idempotent — files
whose SHA-256 matches the existing remote LFS blob are skipped on re-runs.

## Publish the scambench dataset

```bash
uv run python scripts/publish_dataset_to_hf.py \
    --dataset scambench --repo-id elizaos/eliza-1-scambench --dry-run

HF_TOKEN=hf_xxx uv run python scripts/publish_dataset_to_hf.py \
    --dataset scambench --repo-id elizaos/eliza-1-scambench
```

Payload: ~152 MB normalized + ~12 MB synthesized.

## Publish the synthesized examples

```bash
uv run python scripts/publish_dataset_to_hf.py \
    --dataset synthesized --repo-id elizaos/eliza-1-synthesized --dry-run

HF_TOKEN=hf_xxx uv run python scripts/publish_dataset_to_hf.py \
    --dataset synthesized --repo-id elizaos/eliza-1-synthesized
```

Payload: a few MB of action examples + action pairs + core prompts.

## Publish the abliteration calibration set (pointer-only)

This dataset just hosts a README pointing at upstream
`mlabonne/harmless_alpaca`. Run the publish so consumers see the pointer:

```bash
HF_TOKEN=hf_xxx uv run python scripts/publish_dataset_to_hf.py \
    --dataset abliteration --repo-id elizaos/eliza-1-abliteration
```

## Publish the pipeline

```bash
uv run python scripts/publish_pipeline_to_hf.py \
    --repo-id elizaos/eliza-1-pipeline --dry-run

HF_TOKEN=hf_xxx uv run python scripts/publish_pipeline_to_hf.py \
    --repo-id elizaos/eliza-1-pipeline
```

Payload: ~5-10 MB (scripts + docs only — no data, no checkpoints, no
__pycache__). Fast on any connection.

## Bootstrap a Vast box from HF

Once both repos are published, drive a fresh box end-to-end without rsyncing
from your local machine:

```bash
# Option A: use the existing provision-and-train flow with HF bootstrap.
bash scripts/train_vast.sh provision-and-train \
    --registry-key eliza-1-desktop-9b --epochs 1 --bootstrap hf

# Option B: take it step by step.
bash scripts/train_vast.sh provision
bash scripts/train_vast.sh bootstrap-from-hf
bash scripts/train_vast.sh run
```

Override the source repos:

```bash
bash scripts/train_vast.sh bootstrap-from-hf \
    --pipeline-repo elizaos/eliza-1-pipeline \
    --data-repo elizaos/eliza-1-training
```

The remote box installs `uv` and `huggingface_hub[cli]` if missing,
downloads only the active subset of the data repo (train + val + test +
manifest), and runs `uv sync --extra train`. Your local machine can be
powered off after `bootstrap-from-hf` returns.

## Safety rails

- The dataset publisher's per-bundle allowlist refuses to upload anything
  outside the active SFT split. Historical WIP files (`train.jsonl`,
  `train_v8.jsonl`, `train_rewritten.review.jsonl`) are explicitly NOT
  reachable from any `--dataset` choice.
- The pipeline publisher excludes `__pycache__/`, `.pytest_cache/`,
  `*.pyc`, `*.so`, and `.vast_instance_id`.
- `HF_TOKEN` / `HUGGINGFACE_HUB_TOKEN` is read from env only and never
  printed to logs. `VAST_API_KEY` is similarly never echoed.

---

## elizaos org — fused-kernel optimized models

The `elizaos/eliza-1-*` repos ship the Eliza-1 device-tier bundles. Each
published GGUF should be the fused-kernel artifact the local runtimes
actually install:

- **Q4_POLAR** weight quantization (4-bit, Hadamard-rotated, ~38% of bf16)
- **QJL1_256** 1-bit JL-transform K-cache (~7.5x KV-K reduction realized)
- **TBQ V-cache** (`tbq3_0` / `tbq4_0`, ~3-4x KV-V reduction)
- **DFlash** speculative decoding pairing with an Eliza-1 drafter
- llama-server kernels from `milady-ai/llama.cpp` (fork of ggml-org/llama.cpp)

These are the models the on-device Eliza runtime wants to load: a single
GGUF that exercises every kernel the build-llama-cpp-dflash.mjs pipeline
ships (TBQ, QJL, Q4_POLAR, DFlash). Stock-format variants can live under
the same repo's `text/` directory only when the manifest makes their role
explicit.

### Org

- **URL:** https://huggingface.co/elizaos
- **Owner:** Eliza core team. Add new members via HF org settings.
- **Visibility:** repos are public by default once the GGUF is real. Use
  `--no-public` on `publish_milady_model.py` to create a private repo
  for staging.

### One-time org setup

Anyone with org-admin rights at https://huggingface.co/elizaos does
this once:

1. Sign in to HuggingFace with the `elizaos` admin account.
2. Visit https://huggingface.co/organizations/new and create the
   `elizaos` org if it does not already exist.
3. Invite the publishing service account so CI can push.

If the org doesn't exist yet, `publish_milady_model.py` errors out
explicitly with the URL above — it does not silently create the org.

### Token requirements

Push tokens need **write access scoped to the `elizaos` org**:

```bash
# 1. Visit https://huggingface.co/settings/tokens
# 2. Create a "Fine-grained" token with:
#    - Repo: read+write
#    - Org: elizaos (selected)
#    - Token name: e.g. eliza-1-publisher
# 3. Export it locally OR set it as a GitHub secret named ELIZA_HF_TOKEN.
export HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxxx
```

Read-only consumers (the phone, dev clones, CI smoke tests) do NOT need
a token; the `huggingface.co/<repo>/resolve/main/<file>` endpoint is
public for public repos.

### Repo naming convention

| Role                     | Repo                                                  |
|--------------------------|-------------------------------------------------------|
| Inference target (full)  | `elizaos/eliza-1-<tier>`                              |
| Drafter for that target  | hidden companion file in the same `elizaos/eliza-1-<tier>` repo |
| Pairing manifest (siblings) | `manifest.json` inside each repo (target points at drafter) |

`<tier>` follows the catalog ids: `lite-0_6b`, `mobile-1_7b`,
`desktop-9b`, `pro-27b`, and `server-h200`. The target the user installs
is visible; the drafter is hidden from the catalog and only downloaded
as a companion (matching the `runtimeRole: "dflash-drafter"` pattern in
`catalog.ts`).

**Why two repos per pair instead of one with two GGUFs?** HuggingFace
caches the resolve URL per file, the existing downloader keys by
`(hfRepo, ggufFile)`, and the catalog already encodes companion ids.
Keeping target and drafter in the same Eliza-1 repo keeps one ownership
boundary per device tier while preserving the downloader's explicit
`(hfRepo, ggufFile)` key.

### Drafter pairing manifest

Every `elizaos/eliza-1-<tier>` repo ships a `manifest.json` alongside
its GGUFs that records which drafter and which optimization stack the
file expects. Schema:

```json
{
  "version": 1,
  "kind": "eliza-1-optimized",
  "modelId": "eliza-1-mobile-1_7b",
  "base": {
    "name": "eliza-1-mobile-1_7b",
    "displayName": "Eliza-1 Mobile 1.7B",
    "params": "1.7B",
    "tokenizerFamily": "eliza1",
    "contextLength": 32768
  },
  "gguf": {
    "file": "text/eliza-1-mobile-1_7b-q4_k_m.gguf",
    "sha256": "<64-hex>",
    "sizeBytes": 0,
    "quant": "Q4_POLAR + QJL1_256 K + TBQ V"
  },
  "optimization": {
    "weights": "Q4_POLAR",
    "kvK": "QJL1_256",
    "kvV": "TBQ4_0",
    "speculativeDecode": "DFlash",
    "kernels": ["q4_polar", "qjl1_256", "tbq3_0", "tbq4_0", "dflash"],
    "requiresFork": "milady-ai/llama.cpp@v0.1.0-milady"
  },
  "drafter": {
    "repo": "elizaos/eliza-1-mobile-1_7b",
    "file": "text/eliza-1-mobile-1_7b-drafter.gguf",
    "params": "0.6B",
    "tokenizerFamily": "eliza1"
  },
  "pipeline": {
    "publishedAt": "2026-05-10T00:00:00Z",
    "trainedFrom": "elizaos/eliza-1-9b",
    "trainingPipeline": "elizaos/eliza-1-pipeline",
    "buildScript": "packages/training/scripts/publish_milady_model.py"
  }
}
```

The drafter repo ships the inverse — a `manifest.json` whose
`"kind": "eliza-1-drafter"` block points back at the target repo so the
catalog sync script can walk either side and reconstruct pairings.

### Publishing flow

```bash
# Dry-run — refuses to push anything, prints the manifest and what
# would upload. No HF_TOKEN required.
uv run python scripts/publish_milady_model.py \
    --model-dir /path/to/eliza-1-mobile-1_7b \
    --repo-id elizaos/eliza-1-mobile-1_7b \
    --dry-run

# Real push. The script refuses to ship a stock-format GGUF (one
# without Q4_POLAR + QJL1_256 metadata). After upload it writes
# `published.json` next to the GGUF with the canonical URL + sha256
# + size; subsequent runs skip re-upload when the sha matches the
# existing remote LFS pointer.
HF_TOKEN=hf_xxx uv run python scripts/publish_milady_model.py \
    --model-dir /path/to/eliza-1-mobile-1_7b \
    --repo-id elizaos/eliza-1-mobile-1_7b
```

After a publish run, refresh the local-inference catalog so the phone
sees the new URLs:

```bash
uv run python scripts/sync_catalog_from_hf.py \
    --org elizaos \
    --out reports/porting/$(date -u +%Y-%m-%d)/catalog-diff.json
```

The output is a **diff file** — applying it to `catalog.ts` is the
W5-Catalog agent's job; this script never edits the catalog directly.

### Download verification

The phone-equivalent round-trip lives at
`scripts/verify-phone-download.mjs`. It calls the same `Downloader`
class the iOS / Android runtimes use, points its state directory at a
temp dir, and reports time + bytes/sec. Run it from the repo root:

```bash
node scripts/verify-phone-download.mjs --model-id eliza-1-mobile-1_7b
```

This is the gate W5-Catalog uses to decide whether to land a catalog
update — if the sha256 mismatches or the resolve URL 404s, the diff is
not merged.
