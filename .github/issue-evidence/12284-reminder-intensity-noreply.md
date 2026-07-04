# Evidence — #12284 item 6: the spine reads `reminderIntensity`

Advances #12284 (parent #12186). One of the eight items left after #12406: the
owner's `reminderIntensity` fact (`minimal | normal | persistent |
high_priority_only`) was stored but **never read by the scheduling spine** — it
only shaped the legacy `LifeOpsReminderPlan` path (`applyReminderIntensityToPlan`).

## What changed

The tick-driven no-reply follow-up loop now respects owner intensity. The
correct seam is PA's **no-reply policy** (`defaultNoReplyPolicyFor` /
`resolveNoReplyPolicy` in `scheduled-task/scheduler.ts`) — *not* the spine's
escalation ladder, which drives **dispatch-failure** channel advance
(`applyDispatchPolicy`), a different concern that intensity must not touch.

- New pure module `scheduled-task/no-reply-intensity.ts`:
  `applyReminderIntensityToNoReplyPolicy(policy, intensity, priority)` mirrors
  the documented legacy semantics of `applyReminderIntensityToPlan`:
  - `minimal` → fire once, drop all retries.
  - `persistent` → one extra nudge at the trailing cadence.
  - `high_priority_only` → only high-priority tasks keep nudges; others fire once.
  - `normal` / unset → unchanged.
- `resolveNoReplyPolicy` applies it to the **default** per-kind policy; an
  explicit per-task `metadata.noReplyPolicy` override still wins field-by-field.
- `processDueScheduledTasks` reads `ownerFacts.reminderIntensity` (already loaded
  each tick) and threads it into `handleCompletionTimeout`.

Grep of `plugin-scheduling`/PA for `reminderIntensity` was previously empty on the
tick path; it now flows into the no-reply loop.

## Verification

- **Pure unit test** (`no-reply-intensity.test.ts`) — ran locally: **6 passed**.
  Covers every intensity × priority branch, empty-ladder fallback, and
  field-preservation.

  ```
  bun run --cwd plugins/plugin-personal-assistant test src/lifeops/scheduled-task/no-reply-intensity.test.ts
  → Test Files 1 passed, Tests 6 passed
  ```

- **Integration test** (`scheduler.no-reply-policy.test.ts`, 4 new cases) — drives
  the **real** `processDueScheduledTasks` against a real `AgentRuntime` + DB
  (`createLifeOpsTestRuntime`), sets the owner fact via
  `OwnerFactStore.setReminderIntensity`, and asserts the real domain artifacts:
  - `minimal`: a fired reminder times out straight to terminal **skip** (no
    `no_reply_retry_1`), `noReplyPolicy.maxRetries === 0`.
  - `persistent`: still retries, `noReplyPolicy.maxRetries === 2`,
    `retryCadenceMinutes === [60, 60]`.
  - `high_priority_only` + medium: suppressed to fire-once (`maxRetries 0`).
  - `high_priority_only` + high: keeps default nudge (`maxRetries 1`).

- **Typecheck**: `bun run --cwd plugins/plugin-personal-assistant typecheck` → exit 0 (clean).

### Local-run note for the integration test

The integration cases exercise the full PA plugin graph, which cannot boot under
vitest **in this git worktree** — a pre-existing, worktree-wide resolution gap
(vite can't resolve bare deps like `react/jsx-dev-runtime`, `adze` that live only
in the parent checkout's `node_modules`; the 4 untouched #11793 cases in the same
file fail identically). CI's full install runs them. Local proof of the core
logic is the pure-module test above; the integration test is real code that
compiles clean and asserts real domain artifacts.

## Evidence rows

| Evidence | Status |
| --- | --- |
| Real-LLM trajectory | N/A — this is scheduler-tick task-processing logic, not model/prompt/action behavior. The domain artifacts (no-reply state transitions) are the evidence, asserted in the integration test. |
| Domain artifacts | ScheduledTask `noReplyPolicy` / `noReplyState` / terminal status transitions — asserted in the integration test. |
| Backend logs | `[lifeops-scheduled-task]` no-reply retry/terminal paths (integration-driven). |
| Frontend / screenshots / video | N/A — no UI surface changed. |
