# Issue 11383 Evidence - LifeOps Trajectory Checks

## Scope

This PR adds a `modelCallOccurred` scenario final check that reads recorded
trajectory model calls and fails when the expected optimized-prompt `purpose`
did not fire. It wires that check into the LifeOps capability scenarios that
already exercise optimized-prompt consumers:

- `calendar_extract`
- `schedule_plan`
- `reminder_dispatch`
- `inbox_triage`

It also preserves LifeOps task/domain buckets in the native trajectory export
for optimized-prompt purposes used by capability datasets.

## Local Validation

Ran from `C:\Users\Administrator\.codex\worktrees\4a18\eliza-11383-lifeops-trajectory`:

```powershell
bun run --cwd packages/scenario-runner test -- src/final-checks/index.test.ts src/native-export.test.ts
```

Result: passed, 2 files / 22 tests.

```powershell
bunx @biomejs/biome@2.5.2 check packages/scenario-runner/package.json packages/scenario-runner/schema/index.d.ts packages/scenario-runner/schema/index.js packages/scenario-runner/src/executor.ts packages/scenario-runner/src/final-checks/index.ts packages/scenario-runner/src/final-checks/index.test.ts packages/scenario-runner/src/native-export.ts packages/scenario-runner/src/native-export.test.ts plugins/plugin-personal-assistant/test/scenarios/calendar-extract-capability.scenario.ts plugins/plugin-personal-assistant/test/scenarios/inbox-triage-classification-outcome.scenario.ts plugins/plugin-personal-assistant/test/scenarios/reminder-dispatch-capability.scenario.ts plugins/plugin-personal-assistant/test/scenarios/schedule-plan-capability.scenario.ts
```

Result: passed, checked 12 files.

```powershell
git diff --check
```

Result: passed.

## Typecheck

```powershell
bun run --cwd packages/scenario-runner typecheck
```

Result: not runnable to completion in this sparse checkout. The failure is the
existing sparse-worktree dependency surface: many non-checked-out optional
plugins and external deps are missing (`@elizaos/plugin-agent-skills`,
`@elizaos/plugin-local-inference`, `uuid`, `yaml`, `fs-extra`, and related
packages). The new `FinalCheckRuntime` assignment errors from the first draft
were removed before commit.

## Live Trajectory Evidence

N/A from this Windows workstation for this PR update: no live model API key
environment variables (`OPENAI_*`, `ANTHROPIC_*`, `CEREBRAS_*`, `GROQ_*`,
`GOOGLE_*`, `GEMINI_*`, `XAI_*`, `OPENROUTER_*`, or `ELIZA_E2E_*`) are present
in the process environment. The added final checks are intended to make the
next credentialed live run fail loudly if an optimized-prompt consumer is
bypassed.

## Residual Work For Issue 11383

This is a proof-harness slice, not the full issue closure. The organic
`inbox-triage-capability.scenario.ts` planner route still needs a behavior
change so a live user request reaches the triage classifier instead of only
listing/searching already-persisted queue state.
