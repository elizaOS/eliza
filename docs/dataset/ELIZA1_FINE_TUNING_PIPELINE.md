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
- `eliza_native_v1` is the direct input shape consumed by the current Qwen
  path in `packages/training/scripts/format_for_training.py`.
  `eliza.eliza1_trajectory_record.v1` train/val/test rows are a separate
  messages-based trajectory SFT shape; `repair_eval` rows are auxiliary and
  must not be staged as trainable splits.
- Candidate datasets must not mix `eliza_native_v1`, legacy flat
  `ElizaRecord`, Eliza-1 trajectory records, or plain chat-message rows.
- Real user trajectories are never written into a candidate or pushed to
  HuggingFace until the privacy filter/review has been run and attested.
- Dev-time models/providers are provider labels, not dataset identities.
  Native trajectory rows may carry `provider`, `model`, `source_provider`, or
  usage metadata for audit, but the contract is behavior/schema/provenance, not
  a frozen provider list.
- Opus 4.7 generation is prepared but has not been run. Do not claim Opus 4.7
  rows in a candidate manifest until the generation job exists, passes review,
  and is included in the candidate data.

## 1. Collect

Use runtime trajectory export for user/session data. The direct Qwen training
lane is `eliza_native_v1`; each row is a model-boundary record with the exact
request and normalized response. For local supervised splits that can feed
`train_local.py`/`run_pipeline.py` today:

```bash
cd packages/training
uv run python scripts/trajectories_to_sft.py \
  --input /path/to/privacy-reviewed/export.eliza-native.jsonl \
  --output-dir data/trajectory-runs/<run-id> \
  --val-ratio 0.05 \
  --test-ratio 0.05
```

The trajectory-record prep path may also produce
`eliza.eliza1_trajectory_record.v1` records through
`scripts/prepare_eliza1_trajectory_dataset.py`:

```bash
uv run python scripts/prepare_eliza1_trajectory_dataset.py \
  --input /path/to/privacy-reviewed/export.eliza-native.jsonl \
  --output-dir data/trajectory-record-runs/<run-id> \
  --val-ratio 0.05 \
  --test-ratio 0.05 \
  --strict-privacy
```

That output has `train.jsonl`, `val.jsonl`, and `test.jsonl` trainable
success records plus `repair_eval.jsonl` auxiliary records for failed or
low-scoring trajectories. Do not pass `repair_eval.jsonl` to the candidate
publisher as train/validation/test. The current Qwen APOLLO path still formats
only `eliza_native_v1`; use the trajectory-record splits for audit/eval until a
formatter or conversion path is added.

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

Before any real-user export reaches `data/`, run the local privacy filter and
review its output:

```bash
cd packages/training
python3 scripts/privacy_filter_trajectories.py \
  --input /path/to/raw-user-export \
  --output-jsonl /path/to/privacy-reviewed/export.eliza-native.jsonl \
  --ledger-jsonl /path/to/privacy-reviewed/redaction-ledger.jsonl \
  --stats-json /path/to/privacy-reviewed/privacy-stats.json \
  --strict
```

Then confirm all of the following:

- Direct identifiers, secrets, credentials, tokens, private keys, cookies, and
  session IDs are removed or irreversibly redacted.
- Message content that is not needed for model behavior is removed, shortened,
  or replaced with a privacy-preserving surrogate.
- Provider telemetry is treated as audit metadata only. Do not turn provider
  names, latency, costs, cache stats, or provider-specific metadata into a
  required dataset contract.
- The upstream source/split manifest records `sourceKind: user_export`,
  privacy stats/ledger lineage, and `privacy.reviewed: true`.
- The candidate manifest carries that source-manifest attestation forward, or
  the operator passes `--privacy-reviewed` as a human attestation.

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

For prepared Eliza-1 trajectory records, validate the produced directory, then
use only the trainable success splits as model-candidate inputs and keep
`repair_eval.jsonl` out of the candidate:

```bash
uv run python scripts/validate_eliza1_trajectory_dataset.py \
  --input data/trajectory-record-runs/<run-id> \
  --report reports/validate/<run-id>-trajectory-records.json \
  --strict
```

For trajectory-derived splits, validate schema consistency with the candidate
stager before any write:

```bash
uv run python scripts/publish_eliza1_dataset_candidate.py \
  --candidate-id <run-id> \
  --source-kind user_export \
  --source-manifest /path/to/privacy-reviewed/source-manifest.json \
  --train data/trajectory-runs/<run-id>/train.jsonl \
  --validation data/trajectory-runs/<run-id>/val.jsonl \
  --test data/trajectory-runs/<run-id>/test.jsonl
```

This command is a dry-run by default. It fails if the split files mix
`eliza_native_v1`, legacy flat `ElizaRecord`,
`eliza.eliza1_trajectory_record.v1`, and chat-message schemas. For
Eliza-1 trajectory records it also checks that split labels match
train/validation/test and refuses auxiliary `repair_eval` records.

## 4. Stage The HF Dataset Candidate

After validation and privacy review, write the candidate to the local candidate
layout:

```bash
uv run python scripts/publish_eliza1_dataset_candidate.py \
  --candidate-id <run-id> \
  --source-kind user_export \
  --source-manifest /path/to/privacy-reviewed/source-manifest.json \
  --privacy-reviewed \
  --train data/trajectory-runs/<run-id>/train.jsonl \
  --validation data/trajectory-runs/<run-id>/val.jsonl \
  --test data/trajectory-runs/<run-id>/test.jsonl \
  --write
```

If `--source-manifest` already marks `sourceKind: user_export` and
`privacy.reviewed: true`, the publisher carries that attestation forward.
`--privacy-reviewed` is still acceptable when the review approval lives outside
the source manifest. When `--source-manifest` is omitted, the publisher also
looks for `manifest.json` next to the split files or one directory above them.

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
  --repo-id elizaos/eliza-1-training-candidates
```

For `sourceKind: user_export`, pushing additionally requires
`--allow-user-export-push`. That flag should be rare; prefer pushing public or
synthetic candidates and keeping user-export candidates local/private.

## 5. Local Smoke Training: qwen3.5-2b

Use the smallest release target to prove the data path and trainer before
spending cloud hours. Run this only for candidates whose `manifest.json` has
`datasetSchema: eliza_native_v1`:

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
Qwen trainer expects `eliza_native_v1` rows. Legacy flat `ElizaRecord`,
plain chat-message rows, and `eliza.eliza1_trajectory_record.v1` rows need a
conversion/formatter step before this trainer can consume them.

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

- Source manifests should record privacy-filter stats/ledger hashes in a
  stable schema. The candidate publisher carries privacy attestation forward,
  but it does not run the sanitizer or verify ledger contents.
- Opus 4.7 data generation needs a real job, manifest lineage, and review
  before it can appear in any candidate.
- HF candidate promotion is intentionally separate from final model publish.
  A candidate dataset can be useful for Vast bootstrap without implying any
  model bundle is releasable.
