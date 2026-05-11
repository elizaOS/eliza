# Eliza-1 Fine-Tuning Pipeline

This is the operator runbook for taking elizaOS data from collection to an
Eliza-1 training run. It is intentionally conservative: the dataset candidate
is staged before it is pushed, every real-user write path requires a privacy
review, and model release still goes through the existing quantization,
evaluation, and publish gates.

## Non-negotiables

- Vast.ai is the canonical cloud for Eliza-1 training. Nebius is deprecated
  and exists only as an emergency fallback through `scripts/train_nebius.sh`.
- The Qwen-based Eliza-1 training targets are the registry entries in
  `packages/training/scripts/training/model_registry.py`:
  `qwen3.5-2b`, `qwen3.5-9b`, and `qwen3.6-27b`.
- `eliza_native_v1` is the training-ready runtime trajectory shape consumed by
  `packages/training/scripts/format_for_training.py`. Candidate datasets must
  not mix it with legacy `ElizaRecord` rows or plain chat-message rows.
- Real user trajectories are never written into a candidate or pushed to
  HuggingFace until the privacy filter/review has been run and attested.
- Dev-time providers are not pinned into the dataset contract. Native
  trajectory rows may carry `provider`, `model`, `source_provider`, or usage
  metadata for audit, but the contract is behavior/schema/provenance, not a
  frozen provider list.
- Opus 4.7 generation is prepared but has not been run. Do not claim Opus 4.7
  rows in a candidate manifest until the generation job exists, passes review,
  and is included in the candidate data.

## 1. Collect

Use runtime trajectory export for user/session data. The accepted JSON/JSONL
shape is `eliza_native_v1`; each row is a model-boundary record with the exact
request and normalized response. For local supervised splits:

```bash
cd packages/training
uv run python scripts/trajectories_to_sft.py \
  --input /path/to/privacy-reviewed/export.eliza-native.jsonl \
  --output-dir data/trajectory-runs/<run-id> \
  --val-ratio 0.05 \
  --test-ratio 0.05
```

For public/synthetic corpora, use the existing dataset prep scripts instead of
raw scrape-to-train:

```bash
uv run python scripts/download_datasets.py --priority all
uv run python scripts/normalize.py
uv run python scripts/prepare_native_tool_calling_data.py --write-matrix
uv run python scripts/prepare_native_tool_calling_data.py --transform-normalized
uv run python scripts/prepare_native_tool_calling_data.py --validate-native
```

## 2. Privacy Review

Before any real-user export reaches `data/`, confirm all of the following:

- Direct identifiers, secrets, credentials, tokens, private keys, cookies, and
  session IDs are removed or irreversibly redacted.
- Message content that is not needed for model behavior is removed, shortened,
  or replaced with a privacy-preserving surrogate.
- Provider telemetry is treated as audit metadata only. Do not turn provider
  names, latency, costs, cache stats, or provider-specific metadata into a
  required dataset contract.
- The candidate manifest records `sourceKind: user_export` and
  `privacy.reviewed: true`.

The candidate publisher below enforces this attestation for real-user write and
push paths, but it does not replace the privacy review itself.

## 3. Prepare And Validate

Use the native validator and corpus validators before staging:

```bash
cd packages/training
uv run python scripts/prepare_native_tool_calling_data.py --validate-native

uv run python scripts/validate_corpus.py \
  --input data/final/train.jsonl \
  --report reports/validate/train.json \
  --strict
```

For trajectory-derived splits, validate schema consistency with the candidate
stager before any write:

```bash
uv run python scripts/publish_eliza1_dataset_candidate.py \
  --candidate-id <run-id> \
  --source-kind user_export \
  --train data/trajectory-runs/<run-id>/train.jsonl \
  --validation data/trajectory-runs/<run-id>/val.jsonl \
  --test data/trajectory-runs/<run-id>/test.jsonl
```

This command is a dry-run by default. It fails if the split files mix
`eliza_native_v1`, legacy ElizaRecord, and chat-message schemas.

## 4. Stage The HF Dataset Candidate

After validation and privacy review, write the candidate to the local candidate
layout:

```bash
uv run python scripts/publish_eliza1_dataset_candidate.py \
  --candidate-id <run-id> \
  --source-kind user_export \
  --privacy-reviewed \
  --train data/trajectory-runs/<run-id>/train.jsonl \
  --validation data/trajectory-runs/<run-id>/val.jsonl \
  --test data/trajectory-runs/<run-id>/test.jsonl \
  --write
```

The only local write target is:

```text
packages/training/data/candidates/eliza1/<run-id>/
  README.md
  manifest.json
  data/train.jsonl
  data/validation.jsonl
  data/test.jsonl
```

To update a HuggingFace candidate repo, push only after the local candidate has
been staged and reviewed. Use the same source kind and split files used for
the local candidate; this synthetic example re-stages the already-reviewed
candidate directory before pushing:

```bash
HF_TOKEN=hf_xxx uv run python scripts/publish_eliza1_dataset_candidate.py \
  --candidate-id <run-id> \
  --source-kind synthetic \
  --train data/candidates/eliza1/<run-id>/data/train.jsonl \
  --validation data/candidates/eliza1/<run-id>/data/validation.jsonl \
  --test data/candidates/eliza1/<run-id>/data/test.jsonl \
  --write \
  --push \
  --allow-hf-push \
  --repo-id elizalabs/eliza-1-training-candidates
```

For `sourceKind: user_export`, pushing additionally requires
`--allow-user-export-push`. That flag should be rare; prefer pushing public or
synthetic candidates and keeping user-export candidates local/private.

## 5. Local Smoke Training: qwen3.5-2b

Use the smallest release target to prove the data path and trainer before
spending cloud hours:

```bash
cd packages/training
uv run --extra train python scripts/run_pipeline.py \
  --registry-key qwen3.5-2b \
  --run-name <run-id>-qwen35-2b-smoke \
  --train-file data/candidates/eliza1/<run-id>/data/train.jsonl \
  --val-file data/candidates/eliza1/<run-id>/data/validation.jsonl \
  --test-file data/candidates/eliza1/<run-id>/data/test.jsonl \
  --max-samples 1000 \
  --epochs 1 \
  --skip-base-bench
```

If the smoke run formats zero records, stop and inspect schema: the current
Qwen trainer expects `eliza_native_v1` rows.

## 6. Vast Training: qwen3.5-9b And qwen3.6-27b

Vast is the active cloud path. Read `packages/training/scripts/CLOUD_VAST.md`
and use `scripts/train_vast.sh`; do not extend Nebius.

```bash
cd packages/training
export VAST_API_KEY=<vast-key>
export HUGGING_FACE_HUB_TOKEN=<hf-token>

bash scripts/train_vast.sh provision-and-train \
  --registry-key qwen3.5-9b \
  --epochs 1 \
  --bootstrap hf

bash scripts/train_vast.sh provision-and-train \
  --registry-key qwen3.6-27b \
  --epochs 1 \
  --bootstrap hf
```

Default GPU selection comes from `train_vast.sh`: 9B uses a single
Blackwell 6000 target by default; 27B uses `b200-2x` by default. Override only
after checking the memory budget with `scripts/training/memory_calc.py`.

## 7. Quantization, Eval, And Publish Gates

Training is not a release. A releasable Eliza-1 bundle must pass the existing
publish chain:

1. Quantization recipes from the model registry:
   `polarquant`, `turboquant`, `qjl`, `fp8`, and `gguf-q4_k_m` where listed.
2. Kernel verification required by `packages/inference/AGENTS.md`.
3. Text, voice, ASR, end-to-end voice loop, DFlash acceptance, and tier-specific
   memory/thermal gates.
4. Manifest build and README generation from the validated manifest.
5. HuggingFace upload through `scripts/publish_all_eliza1.sh` or the
   orchestrator it calls.

Do not edit `publish_all_eliza1.sh` to skip gates. `defaultEligible: false`
is for automated downgrades of previously good bundles, not first publish.

## Remaining Integration Points

- A named repo-wide privacy filter command should be wired into this runbook
  once one exists. Until then, treat `--privacy-reviewed` as a human
  attestation, not a sanitizer.
- Opus 4.7 data generation needs a real job, manifest lineage, and review
  before it can appear in any candidate.
- HF candidate promotion is intentionally separate from final model publish.
  A candidate dataset can be useful for Vast bootstrap without implying any
  model bundle is releasable.
