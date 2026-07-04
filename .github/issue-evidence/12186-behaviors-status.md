# Issue #12186 — LifeOps learning / proactivity / flexible-scheduling behaviors (Part B) — verification status

Branch: `feat/12186-lifeops-learning-behaviors` (isolated worktree, develop tip `80f9c055ed0`).
Scope: TypeScript only, in `plugins/plugin-scheduling` + `plugins/plugin-personal-assistant` (+ ONE
headless scenario under `packages/test/scenarios/lifeops.personas/`). No new scheduler, no
prompt-text routing, no new connectors — every new behavior is a trigger / gate / completionCheck /
escalation field + registry + owner-fact writer.

This revision incorporates an adversarial review pass (FIX-1..5, all applied — see the dedicated
section below).

## What each task implemented

### B1 — ActivityProfile → OwnerFacts rhythm-window learning writer (plan D.2.1)
The single highest-leverage fix: closes the observe→learn→schedule loop.
- `plugins/plugin-personal-assistant/src/activity-profile/window-learning.ts` — PURE mapping:
  `typicalWakeHour`/`typicalSleepHour` → flexible `morningWindow`/`eveningWindow` (`{startLocal,endLocal}`).
  **The mapping now emits a window ONLY when it is valid for the plugin-scheduling `during_window`
  bounds resolver** (`start < end`, no wraparound for morning/evening); an edge chronotype whose band
  would invert/wrap is skipped, never written as an unsatisfiable window (FIX-1). Plus
  `resolveWindowPatch(current, learned)` enforcing the two invariants — **user-owned windows
  (`provenance.source ∈ {first_run, profile_save}`) are never clobbered**, and a learned window equal
  to the stored one produces **no write (idempotent)**.
- `.../activity-profile/window-learning-writer.ts` — runtime binding: reads `OwnerFactStore`, derives
  windows, applies the override/idempotency policy, writes with `agent_inferred` provenance.
- Wired into `.../activity-profile/proactive-worker.ts` after each profile rebuild — now **guarded by
  try/catch** (log-and-continue), because rhythm learning is a best-effort side-effect that must never
  abort the proactive tick (FIX-2).

### B2 — Wire the two stubbed gates (plan D.2.2 + D.4.1)
Replaced the two warn-once always-allow stubs in
`plugins/plugin-scheduling/src/scheduled-task/gate-registry.ts` with honest built-ins and made
`registerBuiltInGates` **first-wins** (skip a kind already registered), so a richer reader registered
earlier takes precedence.
- `.../plugin-personal-assistant/src/lifeops/scheduled-task/activity-gates.ts` registers the REAL
  ActivityProfile-backed readers in PA's runner wiring (`runtime-wiring.ts`, before the built-ins):
  - `circadian_state_in` — reads `ActivityProfile.isCurrentlySleeping` → allow/deny on the observed
    awake/asleep state (default awake when no profile exists yet).
  - `no_recent_user_message_in` — reads `ActivityProfile.lastSeenAt` + the `message_activity_event`
    bus family; **defers** (reschedules) a proactive poke while the user is active, rather than
    dropping it.
- The plugin-scheduling built-in `no_recent_user_message_in` fallback is a real generic reader over
  `context.activity.hasSignalSince("message_activity_event")` and now **defers** (not denies) when the
  user is active (FIX-3) — a deny would silently drop the poke. The `circadian_state_in` fallback is an
  honest "no evidence of sleep → awake" default. Health packs referencing these kinds still resolve.

### B3 — Behavioural personalBaseline feeder (plan D.2.3)
`behaviouralBaselineFromProfile(profile)` counts observed-rhythm samples (wake hour, sleep hour,
per-platform message history). Fed into the gate context in `runtime-wiring.ts`'s owner-facts provider
as `max(healthBaseline, behaviouralBaseline)`, so `personal_baseline_sufficient` fires once EITHER a
health baseline OR enough observed behaviour exists — no day-one starvation.

### B4 — Persona default packs (plan D.1.2 / D.1.3 / D.5.1 / D.5.2)
`plugins/plugin-personal-assistant/src/default-packs/persona-packs.ts`, all built with
`compileTaskDefinition`, all `defaultEnabled: false` (offered at customize, not auto-seeded):
- `low-energy-support` — soft-only, low-priority `during_window: "morning"` checkin; **inline**
  escalation steps `SOFT_LOW_ENERGY_ESCALATION_STEPS` (two `soft` in-app nudges at 90m/240m, **no urgent
  step**). No `ladderKey` — the runner rejects an unregistered ladder key at schedule time, and inline
  steps already win in `resolveEffectiveLadder` (FIX-4c caught this: the earlier `ladderKey:
  "low_energy_soft"` would have thrown `ScheduledTaskValidationError` for anyone scheduling the pack).
- `adhd-body-double` — "start now" body-double checkin fired `during_window: "morning"` with a light
  `user_replied_within` gate and the same inline soft ladder.
- `object-permanence-watcher` — daily `wake.confirmed` watcher (non-owner-visible) re-surfacing overdue
  todos into the morning brief; no own notification.
Behavioral-activation / body-double framing lives in prompt CONTENT; routing is structural fields only.
Registered into `DEFAULT_PACKS`; `default-packs.schema.test.ts` count updated 10 → 13.

### B5 — Headless `.scenario.ts` tick test (plan E.5 / B5)
`packages/test/scenarios/lifeops.personas/persona.flexible-scheduling.scenario.ts` — deterministic,
`SCENARIO_USE_LLM_PROXY=1` (no key). Seeds owner facts through the REAL `OwnerFactStore`, creates tasks
through the REAL REST surface, drives the REAL scheduler tick and asserts STRUCTURAL outcomes:
`during_window` fires inside the morning window; `relative_to_anchor` fires relative to the wake anchor;
`quiet_hours` DEFERS a low-priority reminder inside the quiet window; a `no_recent_user_message_in`-gated
poke ALLOWS once the user is quiet. **Honest scope (FIX-5):** this scenario exercises only the ALLOW
branch of `no_recent_user_message_in` — a scenario turn cannot inject the mid-run activity signal the
DEFER branch reads. The DEFER/suppression branch is proven headlessly through the SAME real runner by
the unit + simulation tests below, not by this scenario. The scenario's full end-to-end run is CI-gated
(see the "headless tick scenario" verification note).

## Verification — real output

### `bun run --cwd plugins/plugin-scheduling test`
```
 Test Files  19 passed (19)
      Tests  238 passed (238)
```
`gate-registry.test.ts` now has 15 tests, including the FIX-3 fallback-defers-when-active / allows-when-
quiet cases and a first-wins test (a pre-registered custom reader is not overwritten by the built-ins).

### plugin-personal-assistant — tests touching this slice
The full PA suite is too heavy to complete inside the isolated worktree (the whole run exceeds the 2-min
budget). Every test file that touches the changed code passes; run together:
```
$ vitest run src/activity-profile/window-learning.test.ts \
             src/lifeops/scheduled-task/activity-gates.test.ts \
             src/default-packs/persona-packs.test.ts \
             src/activity-profile/proactive-worker.test.ts \
             test/persona-packs.simulation.test.ts \
             test/default-packs.schema.test.ts \
             test/default-pack-spine-seeding.test.ts
 Test Files  7 passed (7)
      Tests  101 passed (101)
```
Breakdown:
- `window-learning.test.ts` — 13 (mapping, override precedence, idempotency, end-to-end writer, and the
  **3 new inverted-window tests** from FIX-1).
- `activity-gates.test.ts` — 11 (circadian allow/deny/asleep/day-one; no-recent allow/defer×2;
  behavioural baseline feeder; **2 new first-wins tests** proving PA's real reader overrides the
  plugin-scheduling fallback — FIX-4b).
- `persona-packs.test.ts` — 10 (soft-only ladder, during_window triggers, anchor watcher, content lint).
- `persona-packs.simulation.test.ts` — 5 (**new, FIX-4c**: drive persona records through the REAL
  in-memory runner — fires at soft intensity, never reaches urgent across the full ladder, during_window
  flexible fire, and `no_recent_user_message_in` DEFER-when-active / ALLOW-when-quiet).
- `proactive-worker.test.ts` — 15 (one-scheduler tripwire; **new, FIX-4a**: the tick actually INVOKES
  the learner and patches `OwnerFacts` with the derived `{07:00,10:00}` / `{21:00,23:00}` windows and
  `agent_inferred` provenance).
- `default-packs.schema.test.ts` + `default-pack-spine-seeding.test.ts` — 47 (13-pack registry, seeding).

Also verified green in this worktree: `plugin-health/src/default-packs/gate-coverage.test.ts` (3),
`plugin-scheduling` runner suite (60), `lifeops-scheduled-task-simulation.test.ts` + pipeline (15),
default-packs smoke/parity/helpers (24).

### Inverted-window regression (FIX-1) — fails before, passes after
Confirmed by temporarily reverting `deriveWindowsFromRhythm` to the pre-fix (unconditional-emit)
behavior and running the 3 new tests:
```
BEFORE FIX (unconditional emit):
 × SKIPS an inverted morning window …   AssertionError: expected { startLocal: '22:00', … } to be undefined
 × SKIPS an inverted evening window …   AssertionError: expected { startLocal: '23:00', … } to be undefined
 × NEVER emits a window with startLocal >= endLocal …   AssertionError: expected 22 to be less than 0
 Tests  3 failed | 10 passed (13)
AFTER FIX (validSameDayWindow guard):
 Tests  13 passed (13)
```

### Typecheck — 0 errors
```
$ bun run --cwd plugins/plugin-scheduling typecheck  →  tsgo --noEmit -p tsconfig.json   (exit 0, no output)
$ bun run --cwd plugins/plugin-personal-assistant typecheck  →  tsc --noEmit -p tsconfig.build.json  (exit 0, no output)
```
(Worktree note: `@types/node` and `react`/`react-dom` had to be symlinked from the parent clone's
`node_modules` — the isolated worktree's own `node_modules` is missing them. Gitignored; environment
only, not a code change. The parent `@elizaos/core` dist was rebuilt once.)

### Headless tick scenario — DISCOVERY VERIFIED; live boot CI-gated on a shared-tree packaging gap
```
$ SCENARIO_USE_LLM_PROXY=1 bun packages/scenario-runner/src/cli.ts list packages/test/scenarios/lifeops.personas
persona.flexible-scheduling
```
The scenario is statically discovered and its `id` is readable. Attempting a full run boots the real
runtime but fails BEFORE any turn on a shared-tree packaging gap unrelated to this change:
```
[eliza-scenarios] fatal: ResolveMessage: Cannot find module '@elizaos/core/contracts/first-run-options'
  from '.../packages/app-core/src/api/credential-resolver.ts'
```
Root cause: `@elizaos/core`'s `./*` export maps `contracts/first-run-options` to
`./dist/contracts/first-run-options.js`, but the core build emits only the per-file `.d.ts` for
`contracts/*` (the runtime code is bundled into the main index) and the `./*` export has no
`eliza-source` condition to fall back to `src`. The reference CI scenario
`deterministic-lifeops-recurrence` fails the same boot in this worktree on a *different* missing dep
(`omggif`). Both are pre-existing shared-tree gaps, not this branch. **The scenario has NOT been executed
end-to-end here** — the scheduler behaviors it targets are proven by the unit + simulation tests (which
drive the SAME real runner), and the scenario will run in CI's full install/build.

## Adversarial-review fixes (FIX-1..5) — all applied

- **FIX-1 [HIGH]** inverted/unsatisfiable `during_window` band: `deriveWindowsFromRhythm` now declines
  to emit any window with `start >= end` after wrap-to-wall-clock (the reader has no morning/evening
  wraparound), so a late-chronotype rhythm never permanently kills the trigger. 3 new tests; proven to
  fail before / pass after.
- **FIX-2 [MED]** the `learnRhythmWindows` call in `executeProactiveTask` is now wrapped in try/catch
  (justified log-and-continue — best-effort learning must not break the tick).
- **FIX-3 [MED]** the built-in `no_recent_user_message_in` fallback now **defers** (delays) instead of
  denying (dropping) the poke; covered by a new gate-registry test.
- **FIX-4 [HIGH]** real behavioral tests independent of the scenario boot: (a) proactive-worker test now
  asserts the learner FIRES and patches `OwnerFacts`; (b) direct first-wins tests (both PA readers
  override the plugin-scheduling fallback); (c) `persona-packs.simulation.test.ts` drives persona packs
  through the REAL runner asserting fire/gate/escalate — this is what caught the FIX-4c `ladderKey` bug.
- **FIX-5 [MED]** the scenario header, title, and this doc no longer claim the `no_recent_user_message_in`
  DEFER branch is proven by the scenario; they state honestly that the scenario exercises the ALLOW
  branch, the DEFER branch is proven by the unit/simulation tests, and the full boot is CI-gated on the
  core packaging gap.

## Domain artifacts inspected in the assertions (not just "green CI")

- **Owner-fact window patch (B1):** `window-learning.test.ts` reads the real `OwnerFactStore` back after
  `learnRhythmWindows` and asserts `morningWindow.value = {07:00,10:00}` / `agent_inferred` provenance,
  the `first_run` no-clobber case, the idempotent `wrote:false` case, and (new) that an inverted band is
  never written. `proactive-worker.test.ts` asserts the SAME owner-fact write happens as a real side
  effect of the tick.
- **Gate decisions (B2/B3):** `activity-gates.test.ts` + `gate-registry.test.ts` assert the exact
  `GateDecision` objects — `{kind:"allow"}` when awake/quiet, `{kind:"deny", reason:"circadian_state_in:
  observed \"asleep\"…"}` when asleep, `{kind:"defer", until:{offsetMinutes:20}, …}` on a 10m-old
  heartbeat inside a 30m window (both PA reader and built-in fallback), and first-wins overriding.
- **Scheduled-task firing + escalation (B4/B5):** `persona-packs.simulation.test.ts` reads the real
  runner's dispatch ledger — `status:"fired"`, first dispatch `intensity:"soft"` on `in_app`, NO
  `urgent` dispatch across the full ladder, and a gated poke suppressed (`dispatches.length === 0`) while
  active vs fired once quiet. The scenario additionally reads `scheduledTaskFires` for during_window /
  anchor fires and a `gate-defer` (reason contains `quiet_hours`) — CI-gated as noted.

## LIVE-model-gated remainder — N/A (no model key in this environment)

Per plan section G, these require a live LLM and are the PR-evidence closeout; they do NOT block the
in-repo work above and are explicitly out of scope for this slice.

- **GEPA optimization (plan G.2): N/A.** Needs `TRAIN_MODEL_PROVIDER=cerebras CEREBRAS_API_KEY=…`.
  Recipe: `bun run --cwd plugins/plugin-training lifeops:gepa -- --trajectories <scenario-run-dir>
  --task schedule_plan` → promotion gate → `<stateDir>/optimized-prompts/schedule_plan/`;
  `OptimizedPromptService` auto-loads at boot.
- **Real-LLM trajectories (plan G.3): N/A.** Recipe (per MEMORY scenario-runner-live recipe):
  `OPENAI_BASE_URL=https://api.cerebras.ai/v1 CEREBRAS_API_KEY=… OPENAI_LARGE_MODEL=gpt-oss-120b
  bun packages/scenario-runner/src/cli.ts run packages/test/scenarios/lifeops.personas --report <out>`
  against a live model, then inspect the JSON report + native jsonl + the resulting owner-fact patch /
  scheduled-task rows by hand. STATIC LifeOpsBench before/after needs only `CEREBRAS_API_KEY`; LIVE mode
  additionally needs `ANTHROPIC_API_KEY` (judge).
- **Frontend evidence: N/A** — no user-facing UI surface in this change (LifeOps is chat + scheduler;
  no cloud-frontend / app view added).
