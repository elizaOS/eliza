# Eliza-1 v1 Hugging Face Publish Plan

This is the operator plan for the active Eliza-1 release line.

Canonical model destination: `elizaos/eliza-1`

Runtime bundles are uploaded under `bundles/<tier>/` in that single model repo.
Do not publish current release bundles to `elizalabs/*` or to per-tier model
repos such as `elizaos/eliza-1-0_8b`.

## Current State

Status as of 2026-05-13:

- Active text tiers are Qwen3.5 only: `0_8b`, `2b`, and `4b`.
- Retired Qwen3 text tiers `0_6b` and `1_7b` are legacy/deprecation targets, not
  current release targets.
- Local staged bundles exist for the active tiers, but they are still blocked
  from upload: `evidence/release.json` records `releaseState: weights-staged`,
  `publishEligible: false`, missing final eval/kernel/platform flags, and no
  HF upload evidence.
- No upload may be described as successful unless a non-dry-run publish returns
  HF commit/url/uploaded-path evidence and `evidence/release.json` is finalized
  with `hf.status: uploaded`.

## Repo Plan

| Repo | Type | Purpose | Publish status |
| --- | --- | --- | --- |
| `elizaos/eliza-1` | model | Single release repo for all active device bundles. Active payloads live at `bundles/0_8b/`, `bundles/2b/`, and `bundles/4b/`. | Target repo only; active bundles are blocked until release evidence is publishable. |
| `elizaos/eliza-1-training` | dataset | Canonical SFT corpus refresh when final train/val/test splits and manifest are present. | Publishable independently of model-bundle gates. |
| `elizaos/eliza-1-evals` | dataset | Eval, gate, and runtime evidence record. Negative or blocking results are published honestly. | Publishable independently of model-bundle gates. |
| `elizaos/eliza-1-assets` | model | Frozen voice/ASR/VAD/cache assets used by bundle staging. | Existing support repo; not the current model-bundle destination. |

Legacy repos such as `elizaos/eliza-1-0_6b`, `elizaos/eliza-1-1_7b`,
`elizaos/eliza-1-0_6b-sft`, and `elizaos/eliza-1-0_6b-sft-weights` are handled
by `deprecate_legacy_qwen3_repos.py`. They should not appear in current upload
commands except as explicit deprecation work.

## Active Tier Matrix

| Tier | Text base | Bundle prefix | Notes |
| --- | --- | --- | --- |
| `0_8b` | `Qwen/Qwen3.5-0.8B` | `bundles/0_8b/` | Small local tier. |
| `2b` | `Qwen/Qwen3.5-2B` | `bundles/2b/` | Mid local tier. |
| `4b` | `Qwen/Qwen3.5-4B` | `bundles/4b/` | Workstation / flagship tier. |

ASR and embedding repos are Qwen3 upstream exceptions where applicable; do not
rename those upstream assets to imaginary Qwen3.5 ASR or embedding repos.

## Required Proof

Before any model-bundle upload:

- `evidence/release.json.repoId` and `evidence/release.json.hf.repoId` must be
  `elizaos/eliza-1`.
- `evidence/release.json.hf.pathPrefix` must be `bundles/<tier>`.
- Pre-upload evidence must be `hf.status: pending-upload` or `upload-ready`;
  it must not claim `uploaded`.
- `publishEligible` and all required `final.*` flags must be true.
- `checksums/SHA256SUMS`, licenses, eval reports, kernel dispatch reports, and
  platform evidence must cover the actual payload files.

After a real upload:

- HF must return a commit id and URL.
- `hf.uploadEvidence.uploadedPaths` must include the committed bundle payload,
  `bundles/<tier>/eliza-1.manifest.json`, and `bundles/<tier>/README.md`.
- Only then may `evidence/release.json.hf.status` become `uploaded`.

## Commands

Dry-run the active single-repo model plan:

```bash
cd packages/training
python -m scripts.publish.publish_eliza1_model_repo \
  --repo-id elizaos/eliza-1 \
  --tier 0_8b --tier 2b --tier 4b \
  --dry-run \
  --report ../../packages/inference/reports/local-e2e/2026-05-13/eliza-1-hf-dry-run-report.json
```

Run the all-up publish status report:

```bash
bun run publish:eliza1 -- --dry-run
```

When every gate is green and HF auth is available, drop `--dry-run` from the
single-repo publisher. If any bundle remains blocked, publish only datasets and
evals, and report the exact blockers.
