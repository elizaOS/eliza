# W3-A default-pack curation rationale

**Owner:** Wave-3 Agent A (W3-A).
**Companion:** `IMPLEMENTATION_PLAN.md` §7.1, `default-packs-rationale.md` (W1-D), `default-pack-simulation-7day.json`.

This doc records what W3-A kept, changed, or punted for each default pack after the 7-day simulation in `scripts/simulate-default-packs.mjs`. Per IMPL §7.1, W3-A is **content curation only** — no schema changes, no pack mechanics changes.

## Simulation profile (recap)

A deterministic 7-day fresh-user simulation against the W1-D default packs plus the offered `habit-starters` and Gmail-connected `inbox-triage-starter`. Owner profile:

- wake at 07:00, bedtime at 23:00 (windows resolved against fixed owner facts);
- replies to the morning check-in 5 of 7 days; expires on D2 (Tue) and D4 (Thu);
- workout skipped Sun, Wed, Sat (3 of 7 occurrences);
- no relationship cadence overdue on D0; one followup emitted from D4 onward.

Outcome shape across the run: 106 total fires, 92 owner-visible nudges, 4 expired (the 2 missed check-ins + their on-skip followups), 3 workout skips, 2 escalation deliveries (medium-priority `priority_medium_default` 30-min in_app retry on each missed check-in).

`defaults-only` scenario (no habit-starters / no Gmail) holds 3–4 user-facing nudge batches per day — well below the 6/day budget the W1-D smoke test pins.

`defaults+habit-starters+inbox` scenario produces 9–14 user-facing batches per day. The pack content cannot reduce that count (the W1-D smoke test only guards the auto-seeded path); the qualitative finding is that habit-starters fan out across multiple windows and do **not** anchor-consolidate (consolidation is anchorKey-keyed; habit-starters use `during_window`). That's a pack-mechanics question, deferred to the W3-A → coordinator handoff (see "Deferrals" below).

## Per-pack disposition

### `daily-rhythm` — KEPT, content unchanged

**Records:** `gm`, `gn`, `morning-checkin`, `morning-checkin-followup`.

**Why kept:** the heartbeat — three messages a day, all anchor-driven, no clock-time literals. The simulation showed:

- gm consolidates with `morning-brief` on `wake.confirmed @ +0` exactly as the smoke test asserts (one merged batch per day).
- The morning check-in expires cleanly on the 2 silent days, the on-skip followup pipeline child fires +60 min later, and `priority_medium_default`'s 30-min `in_app` retry is the only escalation delivery in the entire week. That's the right cadence — invisible to a responsive user, gentle to a busy one.
- gn at bedtime stays low-priority and never escalates.

**Tuning judgment:** prompts are warm, anchor-driven, no embedded conditionals. Nothing to change.

### `morning-brief` — KEPT, content unchanged

**Records:** one `recap` task delegating to `CheckinService.runMorningCheckin`.

**Why kept:** the parity test (`test/default-pack-morning-brief.parity.test.ts`) holds — the prompt continues to produce byte-identical output to the existing CHECKIN service for the morning fixture. After tuning the rest of the pack content, the parity test still passes (re-verified post-tuning).

**Tuning judgment:** the prompt explicitly says "Use the existing morning-checkin assembler — do not regenerate the briefing structure" which keeps the runner from drifting away from the assembler. Don't touch.

### `quiet-user-watcher` — KEPT, threshold confirmed at 3 days

**Records:** one `watcher` task @ `wake.confirmed`, threshold `QUIET_THRESHOLD_DAYS = 3`.

**Why kept and threshold confirmed:** in the simulation, the owner had the worst silence streak of 1 (D2 missed → D2 missed; D4 missed → D4 missed; never two consecutive). With the threshold at 3, no quiet-user observation surfaced — exactly the right behavior for a profile that was busy two non-consecutive days but otherwise responsive.

The §7.1 directive said "default 3 unless simulation shows otherwise." Simulation supports 3. Lowering to 2 would surface a "you've been quiet" observation every time the owner missed a single check-in — that's annoying. Raising to 4 or 5 risks letting genuinely silent users drift. **3 stays.**

**Description tuning (cosmetic):** clarified that `metadata.quietThresholdDays` is a per-task override knob. No code change.

### `followup-starter` — KEPT, default cadence pinned at 14 days via new constant

**Records:** one `watcher` task @ `wake.confirmed`. Children built via `buildFollowupTaskForRelationship`.

**Why kept:** the watcher is silent (`ownerVisible: false`), emits children only when an edge is overdue, and the children fold into the morning brief. In the simulation, no edge was overdue on D0 (no relationships exist on a fresh user); from D4 onward one relationship was synthesized as overdue and the child fired exactly once per day after that.

**Default cadence change:** introduced `DEFAULT_FOLLOWUP_CADENCE_DAYS = 14` exported from `followup-starter.ts` (re-exported via `default-packs/index.ts`). The `RelationshipStore.list({ cadenceOverdueAsOf })` resolver consults this constant when an edge does not carry its own `metadata.cadenceDays` override. Different cadences for the same person across edges (`colleague_of` may carry 7, `friend_of` stays at 14) are still possible — the constant is the floor, not a ceiling.

The `deriveOverdueFollowupTasks` helper continues to propagate the edge's stored `cadenceDays` (or 0 if missing) into the child seed metadata; W1-E's RelationshipStore resolver is the consumer that applies the 14-day default at filter time. Helper-test parity (`treats missing cadenceDays as 0`) is preserved — this is a content/contract addition, not a behavior change in the helper.

**Pack description tuning:** clarified that 14 days is the default and per-edge overrides are first-class.

### `inbox-triage-starter` — KEPT, content unchanged

**Records:** one `recap` task @ 9am owner-local cron, gated by `google.gmail.read` capability.

**Why kept:** the simulation exercised this with a synthetic "Gmail connected" scenario; one daily 9am triage fired and resolved cleanly. No content drift; the prompt explicitly says "do not invent senders or summaries" which the lint corpus already enforces.

**Tuning judgment:** nothing to tune.

### `habit-starters` — KEPT, workout prompt cleaned

**Records:** 8 records, all `defaultEnabled: false`. Offered at first-run customize, not auto-seeded.

**Why kept:** GAP §2.4 — these are the existing 8-template `seed-routines.ts` corpus. The simulation showed them firing as expected when picked up in customize. The fan-out across multiple non-anchor windows is the qualitative pain point (see "Deferrals" below) but the records themselves are right.

**Workout prompt change:** removed an embedded soft conditional. The previous prompt said:

> "Send a workout reminder for the afternoon. Direct, not pleading. Include one micro-line if the user has skipped recently (e.g. 'no pressure if today's not it'); otherwise just the reminder."

…which was an embedded-conditional content branch (`if the user has skipped recently…`) — exactly the pattern the lint corpus is meant to flag. The lint regex didn't catch it because the trigger word is `if the user has` not `if user`, but W3-B's lint promotion will likely tighten this. Cleaned to:

> "Send a workout reminder for the afternoon. Direct, not pleading; one short sentence. Recent reminder outcomes are in context — let them shape tone (e.g. softer after a skip streak) without restating the streak as a fact."

The `contextRequest.includeRecentTaskStates` is unchanged — the LLM still gets the recent-skip context and can shape tone without the prose telling it how. This is the GAP §8.9 spirit: express conditions as context surfaces, not content branches.

## Consolidation policies — no change, but a deferral

`wake.confirmed = merge` works exactly as designed for anchor-keyed records (gm + morning-brief + quiet-watcher + followup-watcher + sleep-recap). The simulation confirms the morning batch reads as one cohesive nudge.

**Deferral:** habit-starters use `during_window` triggers, not `relative_to_anchor`, so they do **not** participate in the wake.confirmed merge even when their windows put them inside the wake hour. A user who picks brush_teeth + shower + drink_water + stretch + vitamins gets up to 5 separate notifications between 06:30 and 08:30 — that's the noisiness the qualitative review surfaced. Fixing it requires either:

1. a window-keyed consolidation policy alongside the existing anchor-keyed one, or
2. routing habit windows to anchors at registration time (e.g. `morning` window → `wake.confirmed +5..+90` with the merge policy applying).

Both are pack-mechanics changes (schema-shaping). **Deferred to coordinator** per §7.1's "no code surface changes that don't fall out of the review."

## Day-one nudge budget — re-verified

The W1-D smoke test (`test/default-packs.smoke.test.ts`) still passes. The auto-seeded defaults (no habit-starters, no Gmail) produce 3 user-facing batches per day in the steady state and 4 on the 2 silent days (gm+brief, checkin, gn, +on-skip followup). All under the ≤ 6/day budget.

## Morning-brief assembler parity — re-verified

`test/default-pack-morning-brief.parity.test.ts` still passes byte-for-byte against `CheckinService.runMorningCheckin` after the tuning. No changes to `morning-brief.ts` content; only adjacent packs were touched.

## Files changed by this curation

- `src/default-packs/habit-starters.ts` — workout prompt content tune.
- `src/default-packs/followup-starter.ts` — added `DEFAULT_FOLLOWUP_CADENCE_DAYS = 14` constant + clarified pack description.
- `src/default-packs/quiet-user-watcher.ts` — clarified pack description.
- `src/default-packs/index.ts` — re-export the new constant.
- `scripts/simulate-default-packs.mjs` — new simulator.
- `docs/audit/default-pack-simulation-7day.json` — new simulation log.
- `docs/audit/default-pack-curation-rationale.md` — this doc.

No test files were modified; no schema fields changed; no pack records added or removed.
