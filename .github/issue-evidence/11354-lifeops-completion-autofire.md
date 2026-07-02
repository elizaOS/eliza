# Issue #11354 — LifeOps completion checks auto-fire

## What Changed

- `MESSAGE_RECEIVED` now drives `user_replied_within` completion for fired scheduled tasks that have an open pending prompt in the same room, gated by owner access.
- The existing `processDueScheduledTasks` tick now evaluates fired `subject_updated` and `health_signal_observed` checks before completion-timeout handling.
- `SubjectStoreView` can be registered per runtime and is read through a live runtime view, so cached runners still see later subject-store wiring.

## Production-Path Evidence

- `plugins/plugin-personal-assistant/src/lifeops/scheduled-task/scheduler.integration.test.ts`
  - Fires a real repository-backed `user_replied_within` check-in through `processDueScheduledTasks`, emits a real `MESSAGE_RECEIVED`, and verifies the DB row transitions to `completed` without an LLM `SCHEDULED_TASKS` action.
  - Verifies fire -> no reply -> still `fired` before timeout.
  - Verifies fired `subject_updated` completes during the production tick before the timeout pass can skip it.

## Commands Run

```bash
bun run --cwd plugins/plugin-birdclaw build
bun run --cwd plugins/plugin-calendar build
bun run --cwd plugins/plugin-scheduling build
```

Result: passed. These generated ignored local `dist/` artifacts required by
the Vitest/package type resolvers after rebasing onto current `origin/develop`.

```bash
bunx vitest run --config plugins/plugin-personal-assistant/vitest.src-integration.config.ts plugins/plugin-personal-assistant/src/lifeops/scheduled-task/scheduler.integration.test.ts
```

Result: passed, 1 file / 13 tests.

```bash
bun run --cwd plugins/plugin-personal-assistant test -- test/lifeops-scheduled-task-simulation.test.ts src/lifeops/domains/reminders-service.process-scheduled-work.test.ts src/lifeops/domains/reminders-service.state-log-rollover.test.ts
```

Result: passed, 3 files / 13 tests.

```bash
bunx @biomejs/biome check plugins/plugin-personal-assistant/src/lifeops/scheduled-task/scheduler.ts plugins/plugin-personal-assistant/src/lifeops/scheduled-task/runtime-wiring.ts plugins/plugin-personal-assistant/src/lifeops/scheduled-task/index.ts plugins/plugin-personal-assistant/src/lifeops/scheduled-task/scheduler.integration.test.ts plugins/plugin-personal-assistant/src/lifeops/domains/reminders-service.ts plugins/plugin-personal-assistant/src/lifeops/domains/reminders-service.process-scheduled-work.test.ts plugins/plugin-personal-assistant/src/lifeops/domains/reminders-service.state-log-rollover.test.ts plugins/plugin-personal-assistant/src/plugin.ts
```

Result: passed, no fixes needed.

```bash
bun run --cwd plugins/plugin-personal-assistant typecheck
```

Result: blocked by pre-existing workspace/dist drift unrelated to this change:

- `@elizaos/plugin-google` type declarations unavailable from this side worktree install.
- Existing `src/lifeops/domains/gmail-service.ts(236,42)` implicit-any after the missing Google import path.
- `@elizaos/app-core/api/auth` built export drift for `ensureSessionForRequest`.

```bash
bun run verify
```

Result: blocked before typecheck/lint by repo-wide type-safety ratchet on current
`origin/develop`: `as unknown as` is `80 / 77` and core/agent/app-core
``?? {}`` is `379 / 377`.

No UI, native, connector, audio, or live-LLM behavior changed in this fix; evidence for those rows is N/A.
