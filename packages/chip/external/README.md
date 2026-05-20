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
