# AI-EDA Dataset Card Template

`claim_boundary`: dataset_card_template_only_no_training_inference_or_release_claim

## Identity

- `dataset_id`:
- `version`:
- `owner`:
- `created_at_utc`:
- `source_assets`:

## Scope

- `record_schemas`: `eda.design_bundle.v1`, `eda.placement_case.v1`, `eda.graph_sample.v1`, `eda.flow_run.v1`, `eda.e1_candidate.v1`
- `designs`:
- `process_nodes`:
- `toolchains`:
- `tasks_supported`:

## Provenance

- `external_sources_lock`:
- `conversion_scripts`:
- `input_hashes`:
- `output_record_hashes`:
- `license_review_status`:

## Labels

- `label_sources`:
- `label_status`:
- `deterministic_replay_required`:
- `blocked_labels`:
- `known_noise_sources`:

## Splits

- `train_split_policy`:
- `validation_split_policy`:
- `test_split_policy`:
- `design_leakage_controls`:
- `benchmark_holdouts`:

## Quality Checks

- `schema_validation`:
- `replay_validation`:
- `deduplication`:
- `range_checks`:
- `missing_data_policy`:

## Restrictions

- `allowed_use`: research and advisory model development.
- `forbidden_use`: release, tapeout, or source modification without deterministic replay and human review.
- `publication_constraints`:
- `redistribution_constraints`:
