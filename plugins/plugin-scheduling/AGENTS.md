# @elizaos/plugin-scheduling

The scheduling spine for elizaOS agents — the storage-agnostic `ScheduledTask`
state machine **and** the always-loaded runtime primitive that HOSTS it. Loaded
on every platform (it is in `CORE_PLUGINS` + `MOBILE_CORE_PLUGINS`).

## Purpose / role

Owns the generic scheduling primitives that any plugin can build on, and the
runtime surface that makes them work standalone:

- The `ScheduledTask` types + the `runner` (storage-agnostic; imports only
  `@elizaos/core` + its own modules).
- Trigger evaluation: `cron` / `interval` / `once` / `event` / `after_task` /
  `relative_to_anchor` / `during_window` (`due.ts`, `next-fire-at.ts`).
- The extensible registries: `TaskGateRegistry`, `CompletionCheckRegistry`,
  escalation-ladder registry, the anchor registry, consolidation policy.
- The runner factory `createScheduledTaskRunner({ … })` — persistence
  (`ScheduledTaskStore`/`ScheduledTaskLogStore`) and the owner/channel/connector
  dependencies are **injected** by the host, not owned here.
- **The dispatch policy** (`dispatch-policy.ts`, enforced inside `fire()`):
  a typed connector `DispatchResult { ok: false }` is never recorded as a
  successful fire. `rate_limited`/`retryAfterMinutes` failures retry the SAME
  step with backoff (bounded, 3 attempts/step); permanent failures advance the
  escalation ladder across channels at each step's `delayMinutes`;
  user-actionable failures also record `metadata.connectorDegradation`; an
  exhausted ladder goes terminal `failed` + `pipeline.onFail`. Retry/advance
  park the row back in `scheduled` with `state.firedAt` = next attempt time
  (the scheduled-override the due evaluation and the `next_fire_at` index both
  honor), surface as fire-result kind `dispatch_deferred`, and write a
  `dispatch_retried`/`escalated` state-log row. Snooze and recurrence-refire
  clear the continuation (`metadata.pendingDispatch`).
- **The runner host service** `ScheduledTaskRunnerService` (serviceType
  `"lifeops_scheduled_task_runner"`, in `scheduled-task/runner-service.ts`) +
  the runtime-injected deps port `registerScheduledTaskRunnerDeps` /
  `getScheduledTaskRunnerDeps`. A built-in **default deps provider** (in-memory
  store, built-in registries, an `in_app`/NOTIFICATION dispatcher, warn-once
  ports, an `ELIZA_PLATFORM`-driven host-capability predicate) runs when no host
  injects production deps — so the runner works on a stock mobile boot.
- **The generic REST surface** at `/api/lifeops/scheduled-tasks`
  (`routes/scheduled-tasks.ts` + `routes/plugin-routes.ts`), registered via the
  plugin's `routes:` array on every platform (path unchanged for the UI).
- **The default-pack seed registry** (`scheduled-task/seed-registry.ts`):
  consumers register packs via `registerDefaultTaskPack`; a boot seeder
  materializes them seed-once. This plugin ships ZERO packs.
- The spine→reminders ports (`ReminderTickHook` + read ports): reminders
  REGISTER a tick-hook into the spine so `@elizaos/plugin-scheduling` never
  imports `@elizaos/plugin-reminders` (dependency points inward).

**Boundary:** `@elizaos/plugin-scheduling` MUST NOT import
`@elizaos/plugin-personal-assistant`, `@elizaos/plugin-reminders`,
`@elizaos/app-core`, or `@elizaos/agent` (those would break the mobile bundle).
A host (`@elizaos/plugin-personal-assistant`) injects the production deps via
`registerScheduledTaskRunnerDeps` (first-wins) and registers its domain packs +
the `SCHEDULED_TASKS` action; PA's dev `/api/lifeops/dev/registries` composite
stays PA-side. Tables stay in PA's `app_lifeops` and are reached via the
injected store (a later optional carve can move them to `app_scheduling`).

Gate: `rg "@elizaos/(app-core|agent|plugin-personal-assistant|plugin-google)"
plugins/plugin-scheduling/src` must return comments/strings only.

See `plugins/plugin-personal-assistant/docs/lifeops-extraction-plan.md` for the
full extraction sequence.

## Commands

```bash
bun run --cwd plugins/plugin-scheduling typecheck
bun run --cwd plugins/plugin-scheduling test
bun run --cwd plugins/plugin-scheduling build
```

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
