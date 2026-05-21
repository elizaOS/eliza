# E1 external AI-EDA assets

This directory stores tracked metadata for external AI-EDA repositories,
datasets, and models used by the E1 optimization stack. Large payloads stay out
of git.

Tracked:

- `SOURCES.lock.yaml`: source registry for reproducible intake.
- `schemas/*.yaml`: lightweight schema manifests for local validation.
- `repos/*/manifest.yaml`, `datasets/*/manifest.yaml`,
  `models/*/manifest.yaml`: optional per-asset overrides.

Ignored:

- downloaded archives;
- cloned repositories;
- extracted datasets;
- model weights and checkpoints;
- converted dataset shards;
- private or foundry-confidential files.

Every AI-generated optimization remains advisory until replayed through the
deterministic E1 gates named in the research plan.

Fresh-machine setup:

```sh
make ai-eda-bootstrap-metadata
python3 scripts/ai_eda/bootstrap_ai_eda_stack.py --profile metadata --run-id fetch-reviewed --asset tilos-macroplacement --asset openroad-eda-corpus --asset circuitnet3 --execute-fetch
make ai-eda-bootstrap-setup-check
make ai-eda-bootstrap-local-smoke
```

Only explicit `--asset` values are fetched. Metadata manifests are tracked;
payload contents stay ignored under `external/repos/*/payload`,
`external/datasets/*/payload`, or `external/models/*/payload`.
