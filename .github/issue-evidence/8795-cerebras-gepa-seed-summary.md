# #8795 Live Cerebras GEPA Seed Evidence

## Commands

All runs used the live Cerebras training provider via:

```bash
TRAIN_MODEL_PROVIDER=cerebras bun run --cwd plugins/plugin-training lifeops:gepa-seed -- --task <task> --generations 1 --population 2 --state-dir "$PWD/.tmp/issue-8795-gepa" --apply
```

## Results

| Task | Dataset | Baseline | Optimized | Delta | Persisted |
| --- | ---: | ---: | ---: | ---: | --- |
| `schedule_plan` | 11 | 0.864 | 0.864 | 0.000 | No; promotion guard refused tied score |
| `calendar_extract` | 11 | 0.826 | 0.826 | 0.000 | No; promotion guard refused tied score |
| `inbox_triage` | 8 | 0.000 | 0.813 | 0.813 | Yes; `8795-inbox-triage-optimized-prompt-artifact.json` |

## Artifacts

- `8795-cerebras-gepa-seed-schedule-plan.log`
- `8795-cerebras-gepa-seed-calendar-extract.log`
- `8795-cerebras-gepa-seed-inbox-triage.log`
- `8795-inbox-triage-optimized-prompt-artifact.json`

## Manual Review

- Confirmed the `schedule_plan` and `calendar_extract` logs reached the live Cerebras path and refused persistence because the optimized prompt did not beat the baseline.
- Confirmed the `inbox_triage` log reached the live Cerebras path, improved by `0.813`, and persisted a real `OptimizedPromptArtifact`.
- Opened the persisted JSON artifact and confirmed it carries `task=inbox_triage`, `optimizer=gepa`, `datasetId=seed:inbox_triage`, `datasetSize=8`, `score=0.8125`, and `baselineScore=0`.
