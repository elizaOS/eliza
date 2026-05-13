# LifeOps Coverage-Gap Implementation Report

Working tree: `/Users/shawwalters/milaidy/eliza/`
Date: 2026-05-09
Companion to: `03-coverage-gap-matrix.md`

## TL;DR — what shipped

The audit at `03-coverage-gap-matrix.md` (lines 422–463) flagged five actions
and one provider as "completely unexercised":

| Symbol | Audit claim | Truth on inspection |
|---|---|---|
| `appBlockAction` | "no test" | No test. Action source already substantive. |
| `deviceIntentAction` | "no test" | No test. Action source already substantive. |
| `lifeOpsPauseAction` | "no test" | `global-pause.integration.test.ts` covers pause/wipe; **never runs in CI** because `*.integration.test.ts` is excluded from the unit lane and the integration lane does not include `plugins/app-lifeops`. |
| `paymentsAction` | "no test" | No test. Action source already substantive. |
| `remoteDesktopAction` | "no test" | No test. Action source already substantive. |
| `roomPolicyProvider` | "no test" | `handoff.e2e.test.ts` references it; no focused contract test. |

**Plugin registration: already done** — all six are registered in
`plugins/app-lifeops/src/plugin.ts` (lines 315–346). The audit's "register in
plugin.ts" deliverable was already complete.

What this PR adds: **6 new `*.test.ts` files + 3 new scenarios**, all of
which run in the default `bun run test` lane.

## Files added

### Test files (run in default unit lane)

All six files run via `bun x vitest run --config vitest.config.ts test/<file>`
inside `plugins/app-lifeops/`. I deliberately named them `*.test.ts` (not
`*.integration.test.ts`) so they actually execute in CI — the existing
`*.integration.test.ts` files in this directory (e.g. `global-pause`,
`lifeops-feature-flags`, `lifeops-action-gating`) are excluded by both the
plugin's `vitest.config.ts` (`defaultUnitExcludes`) and the workspace
`integration.config.ts` (which only includes `eliza/packages/agent/test/**`,
`eliza/apps/*/test/**`, `eliza/packages/app-core/test/**`). That naming gap
is itself a separate bug; this PR does not change the config — it works
around it by using a name pattern that runs.

| File | Tests | What it asserts |
|---|---|---|
| `plugins/app-lifeops/test/app-block.test.ts` | 5 | block/unblock/status subactions dispatch through `app-blocker/engine` correctly; OWNER role gate; result shape (blockedCount, blockedPackageNames, endsAt). Mocks `engine.ts` via `vi.mock`. |
| `plugins/app-lifeops/test/device-intent.test.ts` | 3 | `broadcastIntent` writes the right INSERT into `app_lifeops.life_intents`; defaults to `kind=user_action_requested`, `target=all`; honors `target=specific` with a `targetDeviceId`. Stubs `runtime.adapter.db.execute`. |
| `plugins/app-lifeops/test/lifeops-pause.test.ts` | 6 | pause→resume cycle restores store; `endIso<=startIso` rejected with `INVALID_PAUSE_WINDOW`; wipe with confirmation token succeeds; wipe without confirmation surfaces `CONFIRMATION_REQUIRED`; unknown verb rejected; OWNER role gate. |
| `plugins/app-lifeops/test/payments-action.test.ts` | 5 | `add_source` → `list_sources` round-trip; `import_csv` inserts then dedupes on re-import; `dashboard` returns composite payments view; `remove_source` deletes; `add_source` with no kind/label returns `MISSING_SOURCE_FIELDS`. Uses real PGLite via `createLifeOpsTestRuntime`. |
| `plugins/app-lifeops/test/remote-desktop.test.ts` | 5 | `start` without `confirmed:true` returns `CONFIRMATION_REQUIRED`; `start` with `confirmed:true` in local mode returns `DATA_PLANE_NOT_CONFIGURED` with sessionId + `localMode:true`; `list` enumerates seeded sessions; `revoke` flips state; `revoke` of unknown id returns `SESSION_NOT_FOUND`. Hermetic via `ELIZA_STATE_DIR=tmpdir` + `__resetRemoteSessionServiceForTests`. |
| `plugins/app-lifeops/test/room-policy.test.ts` | 6 | `position=-9`, `dynamic=true`, `cacheScope=turn`; quiet payload when no handoff; quiet payload when no roomId; stay-quiet directive when handoff active; quiet after `store.exit`; per-room scoping (handoff in roomA does not silence roomB). |

**Test totals: 6 files, 30 tests, 30 passing in ~84 seconds.**

Verification command:
```
cd plugins/app-lifeops && bun x vitest run --config vitest.config.ts \
  test/app-block.test.ts test/device-intent.test.ts test/lifeops-pause.test.ts \
  test/payments-action.test.ts test/remote-desktop.test.ts test/room-policy.test.ts
```

### Scenario files (default-CI scenario lane)

Three new scenarios under `eliza/test/scenarios/`:

| File | Domain | What it asserts |
|---|---|---|
| `lifeops.controls/lifeops.pause.vacation-window.scenario.ts` | lifeops/controls | Owner asks "pause everything until next Sunday" → planner routes to `LIFEOPS` action. Final-check asserts `data.verb === "pause"`. |
| `lifeops.controls/lifeops.device-intent.broadcast-reminder.scenario.ts` | lifeops/controls | Owner asks "broadcast a reminder titled 'Stretch'" → planner routes to `DEVICE_INTENT`. Final-check asserts `intent.target === "mobile"` and a non-empty title. |
| `payments/payments.dashboard-spending-summary.scenario.ts` | payments | Owner asks "what does my spending look like" → planner routes to `PAYMENTS`. Final-check asserts the result carries `dashboard.spending.transactionCount` (or `summary.transactionCount`). |

Pre-existing scenarios that already cover these surfaces (verified, not
duplicated):

- `app-block` — covered by 17 scenarios under `test/scenarios/selfcontrol/`
  including `selfcontrol.block-apps.ios-capacitor.scenario.ts`,
  `selfcontrol.block-apps.mobile.scenario.ts`. No new scenario added.
- `remote-desktop` — covered by 8 scenarios under `test/scenarios/remote/`
  (e.g. `remote.vnc.start-session`, `remote.vnc.revoke-session`,
  `remote.pair.local-no-code`, etc.). No new scenario added.
- `room-policy / handoff` — covered by
  `executive-assistant/ea.inbox.propose-group-chat-handoff.scenario.ts` plus
  the e2e test `plugins/app-lifeops/test/handoff.e2e.test.ts` and
  `group-chat-handoff.e2e.test.ts`. The new
  `room-policy.test.ts` adds the focused contract assertion the audit
  flagged as missing.

## Implementation findings

### The audit was partially wrong on registration

All five actions and the provider are **already registered** in
`plugins/app-lifeops/src/plugin.ts` and re-exported from `src/index.ts`. The
audit's task #2 ("Wire into the runtime registry... Add the action/provider
to the array if it's not already there") was already done.

### The actions themselves are real implementations, not stubs

Lines counted for the action sources:

- `app-block.ts`: 608 lines — full block/unblock/status with LLM-driven
  package-name inference, Capacitor plugin integration, owner-gate.
- `device-intent.ts`: 200 lines — full broadcast surface with target/kind
  inference and quoted-substring title/body extraction.
- `lifeops-pause.ts`: 260 lines — full verb=pause/resume/wipe with
  confirmation token + first-run reset.
- `payments.ts`: 415 lines — full mode-router across 8 subactions
  (dashboard / list_sources / add_source / remove_source / import_csv /
  list_transactions / spending_summary / recurring_charges).
- `remote-desktop.ts`: 460 lines — full session lifecycle (start / status /
  end / list / revoke) with pairing-code + local-mode + data-plane gates.
- `providers/room-policy.ts`: 109 lines — full handoff-aware quiet directive
  generation with resume-condition phrasing.

Total: ~2,050 lines of substantive action / provider code that the audit
treated as "completely unexercised."

### The actual gap was tests, not code

The audit-report sentence "Unexercised actions: ... These are direct,
immediate gaps" maps to **test gaps**, not implementation gaps. This PR
closes that gap directly by writing six focused, runnable tests that
exercise each handler against its real side-effect surface.

### Supporting bug discovered

`*.integration.test.ts` files under `plugins/app-lifeops/test/` are not
run by any vitest config in this repo. The plugin's `vitest.config.ts`
explicitly excludes the pattern (line 105 of `vitest.config.ts`,
`defaultUnitExcludes`) and the workspace `integration.config.ts` does not
include `plugins/app-lifeops` in its `include` list (only
`eliza/packages/agent/test/**`, `eliza/apps/*/test/**`,
`eliza/packages/app-core/test/**`). Existing files affected:

- `plugins/app-lifeops/test/global-pause.integration.test.ts`
- `plugins/app-lifeops/test/lifeops-feature-flags.integration.test.ts`
- `plugins/app-lifeops/test/lifeops-action-gating.integration.test.ts`
- `plugins/app-lifeops/test/lifeops-inbox-triage.integration.test.ts`
- `plugins/app-lifeops/test/lifeops-signal-inbound.integration.test.ts`
- `plugins/app-lifeops/test/multilingual-action-routing.integration.test.ts`
- `plugins/app-lifeops/test/cross-channel-search.integration.test.ts`
- `plugins/app-lifeops/test/google-drive.integration.test.ts`
- `plugins/app-lifeops/test/book-travel.approval.integration.test.ts`
- `plugins/app-lifeops/test/approval-queue.integration.test.ts`

This is out of scope for this PR but should be filed: either fix
`integration.config.ts` to include `plugins/app-lifeops/test/**`, or rename
those files to `*.test.ts`. Until that's fixed, those are dead tests in CI.

## What's still pending / out of scope

| Item | Reason |
|---|---|
| Mockoon Plaid mocks | `eliza/test/mocks/mockoon/INVENTORY.md` does not exist in this tree. The `paymentsAction` test uses `kind=manual` (real PGLite, no external service) which is the canonical happy-path. Plaid-specific add-source path remains exercised by the live test lane only. |
| `*.integration.test.ts` config fix | A naming/include fix is needed at the workspace level. Tracked above as "supporting bug discovered." |
| `appBlockAction` LLM-extraction path | Tests bypass `resolveActionArgs`'s LLM extraction by passing parameters explicitly. The LLM-driven `block social media` resolver (`inferAndroidPackageNamesFromIntent` + `resolveAppBlockPlanWithLlm`) is exercised by the existing live `selfcontrol-*.live.e2e.test.ts` files — no new coverage added. |
| Scenarios for `app-block` and `remote-desktop` and the handoff path | Already well-covered by the existing 17 `selfcontrol/*` scenarios, 8 `remote/*` scenarios, and the `executive-assistant/ea.inbox.propose-group-chat-handoff` scenario. No new scenarios added; the audit table already marks these journeys SOLID/SOFT, not NONE. |

## Verification

```
$ cd plugins/app-lifeops && bun x vitest run --config vitest.config.ts \
    test/app-block.test.ts test/device-intent.test.ts test/lifeops-pause.test.ts \
    test/payments-action.test.ts test/remote-desktop.test.ts test/room-policy.test.ts

 Test Files  6 passed (6)
      Tests  30 passed (30)
   Duration  83.83s
```

No new TypeScript errors; the tests run through the same vite-node pipeline
as every other `.test.ts` in the package.
