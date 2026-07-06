# @elizaos/plugin-reminders

The reminder delivery/escalation **data layer** for elizaOS agents — the
`app_reminders` schema carved out of `@elizaos/plugin-personal-assistant`
(LifeOps).

## Purpose / role

Owns the three reminder tables (`life_reminder_plans`, `life_reminder_attempts`,
`life_escalation_states`) under `pgSchema("app_reminders")`, plus a
non-destructive `RemindersMigrationService` that copies existing rows from
`app_lifeops` on first boot (the finances carve-out pattern). PA auto-registers
this plugin via `ensureLifeOpsRemindersPluginRegistered` so the schema +
migration run, and PA's `LifeOpsRepository` reminder SQL now reads/writes
`app_reminders`.

**Boundary:** `@elizaos/plugin-reminders` MUST NOT import
`@elizaos/plugin-personal-assistant`. During the decomposition the
delivery/escalation ENGINE (`service-mixin-reminders.ts`) stays PA-resident,
writing through the carved tables via the repointed repository — a later slice
can lift the engine here behind the `@elizaos/plugin-scheduling` tick-hook ports.

See `plugins/plugin-personal-assistant/docs/lifeops-extraction-plan.md`.

## Conventions / gotchas

- **`@elizaos/plugin-sql` must be loaded first** — the schema is registered via
  the plugin `schema` field; the SQL plugin owns the migration runner.
- Table + column names are preserved verbatim from `app_lifeops` so the copy
  migration is a straight `INSERT … SELECT`.
- The migration is non-destructive: it never drops/alters the `app_lifeops`
  source; it skips when the source is missing or the target already has data.

See the root `AGENTS.md` for repo-wide architecture rules.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — agent behavior / app plugin:**
- A **live-LLM** scenario trajectory showing the behavior end to end and asserting the **outcome**, not just that routing/an action was selected (see #9970).
- The artifacts the behavior creates — memories, knowledge, scheduled-task rows, relationships, documents, outputs — inspected after the run.
- Backend `[ClassName]` logs of the action/service/runner firing, plus error/edge/permission paths.
- The empty-state and adversarial-input behavior, not just one happy scenario.
<!-- END: evidence-and-e2e-mandate -->
