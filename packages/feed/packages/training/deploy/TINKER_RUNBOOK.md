# Tinker Runbook

Use this when Babylon training runs on Tinker instead of a self-managed GPU box.

## Flow

- Loads real trajectories from Postgres or a Hugging Face export
- Scores and groups them in the canonical pipeline
- Sends the curated groups to Tinker for remote training
- Writes a local `training_manifest.json` plus a remote checkpoint reference

## Required Environment

```bash
export TINKER_API_KEY=...
```

Choose one trajectory source.

```bash
# Direct DB access
export DATABASE_URL=postgresql://...
```

```bash
# Remote-friendly dataset export
export TRAJECTORY_SOURCE=huggingface
export HF_TRAJECTORY_DATASET=your-org/scambench-trajectories
export HF_TRAJECTORY_SPLIT=raw
```

## Commands

From `packages/training`:

```bash
make tinker-pipeline \
  STEPS=500 \
  OUTPUT=./trained_models/tinker-run \
  TRAJECTORY_SOURCE=huggingface \
  HF_DATASET=your-org/scambench-trajectories \
  HF_SPLIT=raw
```

Direct Python entrypoint:

```bash
cd python
./.venv/bin/python scripts/run_pipeline.py \
  --training-backend tinker \
  --trajectory-source huggingface \
  --hf-dataset your-org/scambench-trajectories \
  --hf-split raw \
  --tinker-steps 500 \
  --rl-steps 100 \
  --output ../trained_models/tinker-run
```

## Outputs

- `training_manifest.json`
- `tinker_trained/training_result.json`
- `tinker_trained/checkpoint.tar`
- `tinker_trained/exported_adapter/`
- `tinker_training_metrics.jsonl`
- `rl/post_training_report.json`
- `rl/tinker_trained/checkpoint.tar`
- `rl/tinker_trained/exported_adapter/`
- `served_eval_tinker.json`
- `scambench_results.json`
- `rlvr_pipeline_report.json`
- `rlvr_pipeline_health.json`

The manifest records:
- `backend=tinker`
- `remote_base_model_ref=<initial sampler checkpoint>`
- `remote_model_ref=<final sampler checkpoint>`
- `remote_state_ref=<resumable training checkpoint>`
- downloaded archive and extracted adapter paths when export succeeds

`your-org/scambench-trajectories` is a placeholder. The repo does not currently publish a public ScamBench Hugging Face dataset id.

## Post-Run Validation

Run the pinned dependency audit from `packages/training/python`:

```bash
./.venv/bin/python scripts/audit_prod_dependencies.py \
  --output /tmp/rlvr-pip-audit.json
```

Validate training and eval artifacts:

```bash
./.venv/bin/python scripts/check_rlvr_pipeline_health.py \
  --report ./rlvr_output/rlvr_pipeline_report.json \
  --output ./rlvr_output/rlvr_pipeline_health.json
```

Promote a validated release:

```bash
./.venv/bin/python scripts/manage_rlvr_release.py promote \
  --report ./rlvr_output/rlvr_pipeline_report.json \
  --release-root ./releases/rlvr \
  --label scam-defense
```

Promotion copies the adapter, score report, decision output, and pipeline report into the release directory. Rollback uses the packaged release artifacts and does not depend on the original training output tree still existing.

Rollback to the previous promoted release:

```bash
./.venv/bin/python scripts/manage_rlvr_release.py rollback \
  --release-root ./releases/rlvr
```

## Limits

- Tinker RL now resumes from the SFT `remote_state_ref`, but it still uses Tinker-native training/sampling rather than the local Atropos process stack.
- Served eval and ScamBench use Tinker’s OpenAI-compatible endpoint, so they require `TINKER_API_KEY` to be present at evaluation time.
- The downloaded archive is intended as a portable artifact; whether it can be fused into a local full model depends on the local transformers/PEFT stack and the checkpoint format.
- The pinned Python lockfile is audited by `audit_prod_dependencies.py`. That does not cover the wider Bun workspace. If the deployment also ships Bun-managed services, run `bun audit --json` from the repo root and treat any unresolved advisories there as a separate release blocker.
- The control-plane checks cover smoke runs, judge throughput, health checks, release promotion, and rollback. Full GPU or remote Tinker training throughput still needs qualification on the target infrastructure before production rollout.
