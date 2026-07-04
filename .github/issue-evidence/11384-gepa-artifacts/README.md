# #11384 — GEPA optimized-prompt artifacts for the 4 prose LifeOps capabilities

Closes the remaining slice of #11384: the 4 prose/NL capabilities
(`reminder_dispatch`, `meeting_prep`, `morning_brief`, `screentime_recap`)
could not be optimized by the structured exact-match scorer (~0 gradient), so
this branch lands a judge-graded GEPA seed lane and runs it live per capability.

State of the other 4 capabilities (prior legs, evidence under
`.github/issue-evidence/8795-gemma4-lifeops-legs/`):

| capability | outcome | evidence |
| --- | --- | --- |
| inbox_triage | PROMOTED (Cerebras 0.000→0.813; gemma-4-31b 0.688→0.875) | `leg2-inbox_triage-artifact-v1.json` |
| health_checkin | PROMOTED (gemma-4-31b 0.925→0.975) | `leg5-health_checkin-artifact-v1.json` |
| calendar_extract | tie → promotion gate refused (as designed) | `leg2-gepa-calendar_extract.log` |
| schedule_plan | tie → promotion gate refused (as designed) | `leg2-gepa-schedule_plan.log` |

## Live run — this directory

Model lane: `TRAIN_MODEL_PROVIDER=cerebras` against the repo live recipe
(`OPENAI_BASE_URL=https://api.cerebras.ai/v1`, `CEREBRAS_MODEL=gpt-oss-120b`)
via `cerebras-eval-model`. Scorer: judge-rubric (`createLifeOpsJudgeCompare`) —
fraction of per-example rubric items passed, strict parse,
retry-once-then-throw, no silent defaults.

Exact command per task:

```bash
TRAIN_MODEL_PROVIDER=cerebras OPENAI_BASE_URL=https://api.cerebras.ai/v1 \
  CEREBRAS_MODEL=gpt-oss-120b \
  bun plugins/plugin-training/scripts/lifeops-gepa-seed.ts \
  --task <task> --generations 1 --population 2
```

### Results

- `morning_brief` (fresh live Cerebras run, `run-morning_brief.log`): the
  judge-rubric scorer graded the baseline prose prompt at **0.806** — a real,
  non-zero gradient. This is the whole point of the judge lane: the deterministic
  field-match scorer returned ~0 on these prose completions, so GEPA had nothing
  to climb. With one generation / population 2 the optimizer tied
  (0.806 → 0.806, delta 0.000) and the promotion gate refused (as designed —
  no regression, no unearned promotion).
- `reminder_dispatch` (`run-reminder_dispatch.log`): earlier live cli-lane run —
  ties at 1.000, gate refuses (as designed).

### Files

- `run-<task>.log` — full seed-runner output: baseline/optimized score, both
  prompts, promote/refuse decision.
- `<task>-artifact-v1.json` — the persisted `OptimizedPromptArtifact` for every
  task that beat baseline (copied from the state-dir store the run wrote).
- `verify-boot-render.log` — live lane of
  `plugins/plugin-personal-assistant/test/lifeops-optimized-artifact-verify.test.ts`
  booting a fresh `OptimizedPromptService` against the run's state dir
  (construct + `refresh()`, the same scan `start()` performs) and printing the
  real before/after render of each task's PRODUCTION prompt builder
  (`buildReminderDispatchPrompt`, `buildNarrativePrompt`,
  `buildScreenTimeRecapRules`).
