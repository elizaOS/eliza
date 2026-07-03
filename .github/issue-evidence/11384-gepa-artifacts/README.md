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

Host: subscription-only (no ANTHROPIC/OPENAI/CEREBRAS API key in env);
model lane: `TRAIN_MODEL_PROVIDER=cli` → plugin-cli-inference `ClaudeCli`
(`claude --print`, model `claude-haiku-4-5-20251001`, CLI reads its own
`~/.claude/.credentials.json`; #10757). Budget per task: generations=2,
population=4 (same bound as the prior gemma legs). Scorer: judge-rubric
(`createLifeOpsJudgeCompare`) — fraction of per-example rubric items passed,
strict parse, retry-once-then-throw.

Exact command per task:

```bash
TRAIN_MODEL_PROVIDER=cli EVAL_MODEL_PROVIDER=cli \
  bun plugins/plugin-training/scripts/lifeops-gepa-seed.ts \
  --task <task> --apply --state-dir <state-dir>
```

### Results

<!-- RESULTS -->

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
- `runner-progress.txt` — wall-clock task start/exit ledger.
