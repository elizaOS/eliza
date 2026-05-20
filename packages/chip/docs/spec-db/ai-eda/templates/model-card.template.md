# AI-EDA Model Card Template

`claim_boundary`: model_card_template_only_no_training_inference_or_release_claim

## Identity

- `model_id`:
- `model_family`:
- `version`:
- `owner`:
- `created_at_utc`:

## Intended Use

- `allowed_use`: advisory optimization proposal generation only.
- `forbidden_use`: release, tapeout, or source modification without deterministic replay and human review.
- `target_tasks`: placement, synthesis policy, timing/congestion prediction, verification stimulus, or other named task.

## Training Data

- `dataset_cards`:
- `source_records`:
- `train_validation_test_split_policy`:
- `known_overlap_risks`:
- `license_constraints`:

## Method

- `architecture`:
- `features`:
- `labels`:
- `losses`:
- `hyperparameters`:
- `hardware`:
- `random_seeds`:

## Evaluation

- `offline_metrics`:
- `deterministic_replay_gates`:
- `held_out_designs`:
- `negative_controls`:
- `baseline_comparisons`:
- `failure_modes`:

## Safety

- `required_acceptance_gates`:
- `blocked_release_conditions`:
- `manual_review_requirements`:
- `artifact_quarantine_path`: `build/ai_eda/...`

## Provenance

- `training_run_records`:
- `model_artifact_hashes`:
- `code_revision`:
- `tool_versions`:
- `repro_command`:
