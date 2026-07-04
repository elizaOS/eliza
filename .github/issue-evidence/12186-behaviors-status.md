# Issue #12186 — LifeOps learning / proactivity / flexible-scheduling behaviors (Part B) — verification status

Branch: `feat/12186-lifeops-learning-behaviors` (isolated worktree, develop tip `80f9c055ed0`).
Scope: TypeScript only, in `plugins/plugin-scheduling` + `plugins/plugin-personal-assistant` (+ ONE
headless scenario under `packages/test/scenarios/lifeops.personas/`). No new scheduler, no
prompt-text routing, no new connectors — every new behavior is a trigger / gate / completionCheck /
escalation field + registry + owner-fact writer.

## What each task implemented

### B1 — ActivityProfile → OwnerFacts rhythm-window learning writer (plan D.2.1)
The single highest-leverage fix: closes the observe→learn→schedule loop.
- `plugins/plugin-personal-assistant/src/activity-profile/window-learning.ts` — PURE mapping:
  `typicalWakeHour`/`typicalSleepHour` → flexible `morningWindow`/`eveningWindow` (`{startLocal,endLocal}`),
  wrapping past-midnight hours; plus `resolveWindowPatch(current, learned)` implementing the two
  invariants — **user-owned windows (`provenance.source ∈ {first_run, profile_save}`) are never
  clobbered**, and a learned window equal to the stored one produces **no write (idempotent)**.
- `.../activity-profile/window-learning-writer.ts` — runtime binding: reads `OwnerFactStore`,
  derives windows, applies the override/idempotency policy, writes with `agent_inferred` provenance.
- Wired into `.../activity-profile/proactive-worker.ts` after each profile rebuild so a fresh rhythm
  estimate flows straight into `during_window` triggers + wake/bedtime anchors.

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
  `context.activity.hasSignalSince("message_activity_event")`; the `circadian_state_in` fallback is an
  honest "no evidence of sleep → awake" default. Health packs referencing these kinds still resolve.

### B3 — Behavioural personalBaseline feeder (plan D.2.3)
`behaviouralBaselineFromProfile(profile)` counts observed-rhythm samples (wake hour, sleep hour,
per-platform message history). Fed into the gate context in `runtime-wiring.ts`'s owner-facts
provider as `max(healthBaseline, behaviouralBaseline)`, so `personal_baseline_sufficient` fires once
EITHER a health baseline OR enough observed behaviour exists — no day-one starvation.

### B4 — Persona default packs (plan D.1.2 / D.1.3 / D.5.1 / D.5.2)
`plugins/plugin-personal-assistant/src/default-packs/persona-packs.ts`, all built with
`compileTaskDefinition`, all `defaultEnabled: false` (offered at customize, not auto-seeded):
- `low-energy-support` — soft-only, low-priority `during_window: "morning"` checkin; inline escalation
  ladder `SOFT_LOW_ENERGY_ESCALATION_STEPS` (two `soft` in-app nudges at 90m/240m, **no urgent step**).
- `adhd-body-double` — "start now" body-double checkin fired `during_window: "morning"` with a light
  `user_replied_within` gate and the same soft ladder.
- `object-permanence-watcher` — daily `wake.confirmed` watcher (non-owner-visible) re-surfacing overdue
  todos into the morning brief; no own notification.
Behavioral-activation / body-double framing lives in prompt CONTENT; routing is structural fields only.
Registered into `DEFAULT_PACKS`; `default-packs.schema.test.ts` count updated 10 → 13.

### B5 — Headless `.scenario.ts` tick test (plan E.5 / B5)
`packages/test/scenarios/lifeops.personas/persona.flexible-scheduling.scenario.ts` — deterministic,
`SCENARIO_USE_LLM_PROXY=1` (no key). Seeds owner facts (timezone, `morningWindow` 07:00–10:00,
`quietHours` 22:00–06:00) through the REAL `OwnerFactStore`, creates tasks through the REAL REST
surface (`POST /api/lifeops/scheduled-tasks`), and drives the REAL scheduler tick (`worker:
"lifeops_scheduler"`, injected `now`) to assert STRUCTURAL outcomes, not routing:
1. `during_window` fires INSIDE the morning window;
2. `relative_to_anchor` fires relative to the wake anchor;
3. `quiet_hours` DEFERS a low-priority reminder inside the quiet window (`reason ~ quiet_hours`);
4. `no_recent_user_message_in` ALLOWS a poke once the user is quiet.
Modeled on the green CI scenario `deterministic-lifeops-recurrence.scenario.ts`.

## Verification — real output

### `bun run --cwd plugins/plugin-scheduling test`
```
 Test Files  19 passed (19)
      Tests  235 passed (235)
```
Includes `gate-registry.test.ts` (12) — first-wins built-ins + real gate readers still resolve for the
health packs — and the full runner/escalation/due suite.

### plugin-personal-assistant — tests touching this slice
The full PA suite is too heavy to complete inside the isolated worktree (2-min budget timeout on the
whole run). Every test file that touches the changed code passes; run together:
```
$ vitest run src/activity-profile/window-learning.test.ts \
             src/lifeops/scheduled-task/activity-gates.test.ts \
             src/default-packs/persona-packs.test.ts \
             src/activity-profile/proactive-worker.test.ts \
             test/default-packs.schema.test.ts \
             test/default-pack-spine-seeding.test.ts
 Test Files  6 passed (6)
      Tests  90 passed (90)
```
Breakdown:
- `window-learning.test.ts` — 10 (mapping, override precedence, idempotency, end-to-end writer).
- `activity-gates.test.ts` — 9 (circadian allow/deny/asleep/day-one; no-recent allow/defer×2;
  behavioural baseline feeder).
- `persona-packs.test.ts` — 10 (soft-only ladder, during_window triggers, anchor watcher, content lint).
- `proactive-worker.test.ts` — 14 (one-scheduler tripwire; mock runtime given a cache for the learner).
- `default-packs.schema.test.ts` + `default-pack-spine-seeding.test.ts` — 47 (13-pack registry, seeding).

Also verified green in this worktree: `plugin-scheduling/gate-registry.test.ts`,
`plugin-health/src/default-packs/gate-coverage.test.ts` (3), `plugin-scheduling` runner suite (60),
`lifeops-scheduled-task-simulation.test.ts` + pipeline (15), default-packs smoke/parity/helpers (24).

### Typecheck — 0 errors in changed files
```
$ bun run --cwd plugins/plugin-scheduling test  →  tsgo --noEmit -p tsconfig.json   (no output = 0 errors)
$ bun run --cwd plugins/plugin-personal-assistant typecheck  →  tsc --noEmit -p tsconfig.build.json  (no output = 0 errors)
```
(Worktree note: `@types/node` and `react`/`react-dom` had to be symlinked from the parent clone's
`node_modules` — the isolated worktree's own `node_modules` is missing them. Gitignored; environment
only, not a code change.)

### Headless tick scenario — DISCOVERY VERIFIED; live boot blocked by a shared-tree packaging gap
```
$ SCENARIO_USE_LLM_PROXY=1 bun packages/scenario-runner/src/cli.ts list packages/test/scenarios/lifeops.personas
persona.flexible-scheduling
```
The scenario is statically discovered and its `id` is readable. Attempting a full run boots the real
runtime but fails BEFORE any turn on a shared-tree dependency/packaging gap unrelated to this change:
```
[eliza-scenarios] fatal: ResolveMessage: Cannot find module '@elizaos/core/contracts/first-run-options'
  from '.../packages/app-core/src/api/credential-resolver.ts'
```
Root cause: `@elizaos/core`'s `./*` export maps `contracts/first-run-options` to
`./dist/contracts/first-run-options.js`, but the core build emits only the per-file `.d.ts` for
`contracts/*` (the runtime code is bundled into the main index) and the `./*` export has no
`eliza-source` condition to fall back to `src`. The reference CI scenario
`deterministic-lifeops-recurrence` fails the same boot in this worktree on a *different* missing dep
(`omggif`). Both are pre-existing shared-tree gaps, not this branch. The scenario is built on that
exact green-in-CI pattern and typechecks clean; its tick execution will run in CI's full install/build.

## Domain artifacts inspected in the assertions (not just "green CI")

- **Owner-fact window patch (B1):** `window-learning.test.ts` reads the real `OwnerFactStore` back
  after `learnRhythmWindows` and asserts `morningWindow.value = {07:00,10:00}` with
  `provenance.source = "agent_inferred"`; the override case asserts a `first_run` morning window is
  left byte-identical while the evening window is learned; the idempotency case asserts `wrote:false`.
- **Gate decisions (B2/B3):** `activity-gates.test.ts` asserts the exact `GateDecision` objects —
  `{kind:"allow"}` when awake / quiet, `{kind:"deny", reason:"circadian_state_in: observed \"asleep\"…"}`
  when asleep, and `{kind:"defer", until:{offsetMinutes:20}, …}` when the user was seen 10m ago inside a
  30m window (defer math verified), plus the `message_activity_event` bus path.
- **Scheduled-task firing (B5):** the tick scenario reads `scheduledTaskFires` from the real scheduler
  and asserts, per captured `taskId`, `status:"fired"` for during_window/anchor/poke and a
  `gate-defer` (reason contains `quiet_hours`) with no fire for the quiet-hours reminder; a final check
  asserts ≥3 real deliveries through a scenario-registered channel.
- **Persona pack routing (B4):** `persona-packs.test.ts` asserts the compiled records carry
  `trigger.kind:"during_window"` / `relative_to_anchor`, soft-only escalation steps, and pass the
  default-pack content lint (no PII / hardcoded times / conditionals in prompt text).

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

## Commits on this branch (feature slice)
```
31381c83ebc test(#12186): give proactive-worker tripwire mock runtime a cache for the rhythm learner
3a5bd1938ea feat(#12186): headless tick scenario for persona flexible scheduling
a65ff8cac5e feat(#12186): persona default packs (soft escalation, ADHD body-double, object-permanence watcher)
6d915791758 feat(#12186): wire real circadian_state_in + no_recent_user_message_in gates; behavioural baseline feeder
091968181aa feat(#12186): ActivityProfile→OwnerFacts rhythm window learning writer
```
