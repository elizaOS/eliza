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
make PYTHON=/usr/bin/python3 AI_EDA_RUN_ID=fresh-host ai-eda-bootstrap-metadata
make PYTHON=/usr/bin/python3 AI_EDA_RUN_ID=fresh-host ai-eda-backend-preflight
python3 scripts/ai_eda/bootstrap_ai_eda_stack.py --profile metadata --run-id fetch-reviewed --asset tilos-macroplacement --asset openroad-eda-corpus --asset circuitnet3 --asset chipbench-d --asset openabc-d --asset aieda-idata --asset edalearn --asset macro-place-challenge-2026 --asset mlcad-2023-fpga-macro --asset chipdiffusion --asset chipformer --asset core-placement --asset maptune --asset abc-rl --asset abcrl --asset rl4ls --asset mcp4eda --asset orfs-agent --asset openroad-agent --asset openroad-mcp --asset open3dbench --asset dreamplace --asset chiplingo --asset veoplace-vlm --asset audopeda --asset ppa-3dic-surrogate-2026 --execute-fetch
make PYTHON=/usr/bin/python3 AI_EDA_RUN_ID=fresh-host ai-eda-bootstrap-setup-check
make PYTHON=/usr/bin/python3 AI_EDA_RUN_ID=fresh-host ai-eda-bootstrap-local-smoke
```

Only explicit `--asset` values are fetched. Metadata manifests are tracked;
payload contents stay ignored under `external/repos/*/payload`,
`external/datasets/*/payload`, or `external/models/*/payload`.
Use a unique `AI_EDA_RUN_ID` for each machine or CI job to keep generated
records and reports isolated under `build/ai_eda/`.
`ai-eda-backend-preflight` checks optional local backends such as ZigZag,
Timeloop/Accelergy, RTL-MUL, LLM4DV, AssertLLM, and Fault without installing
packages, cloning repositories, downloading model weights, or making release
claims.
Paper and method-reference entries use metadata-only payloads. For example,
`python3 scripts/ai_eda/fetch_external_asset.py --asset assertllm --execute`
writes an ignored provenance record and file hash manifest, not a downloaded
paper, model, generated assertion, or release artifact.
