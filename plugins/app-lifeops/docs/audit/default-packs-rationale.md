# W1-D default-pack curation rationale

**Owner:** W1-D — Wave-1 Agent D.
**Companion:** `IMPLEMENTATION_PLAN.md` §3.4, `GAP_ASSESSMENT.md` §2.4 / §3.13 / §3.16, `wave1-interfaces.md` §6.

This is the per-pack "why it's in / out, what the user sees on day one" doc that IMPL §3.4 calls for as a deliverable.

## Goal

The "agent feels alive on day one" goal is downstream of these packs. A fresh user who picks defaults must:

- get a small, predictable number of nudges (≤ 6 across 24h),
- see at least one assembled briefing that exercises CheckinService end-to-end,
- never see PII, hardcoded clock times, or absolute paths,
- be able to opt into deeper habits without being subjected to them by default.

## Pack inventory

### `daily-rhythm` — auto-enabled

**Records:** `gm` (low priority @ wake.confirmed), `gn` (low @ bedtime.target), `morning-checkin` (medium @ wake.confirmed +30 min, `completionCheck.user_replied_within(60min)`, `pipeline.onSkip` → followup).

**Why in:** the agent's heartbeat. Three messages a day, all anchored to the wake / bedtime cycle so the user never sees a fixed clock-time nudge. The check-in is medium priority because we want a 30-min retry if the owner doesn't respond — that's the difference between a "live" agent and a passive timer.

**Day-one experience:** "good morning, [name]" at the morningWindow.start. 30 minutes later, the morning check-in. "good night" at the bedtimeWindow target. If the user doesn't reply to the check-in within 60 min, one followup nudge fires.

### `morning-brief` — auto-enabled

**Records:** one `recap` task @ wake.confirmed delegating assembly to `CheckinService.runMorningCheckin` (parity-tested in `test/default-pack-morning-brief.parity.test.ts`).

**Why in:** the existing CheckinService already produces an excellent morning brief — overdue todos, today's meetings, yesterday's wins, habit summaries, plus inbox/calendar/contacts/promises sections. The default-pack record exists so the planner is no longer the only path to that content; the runner can fire the brief on the wake anchor without an explicit `/morning check-in` invocation.

**Day-one experience:** the assembled brief lands in the same merged `wake.confirmed` consolidation as `gm`, so the user sees one cohesive read instead of two notifications.

### `quiet-user-watcher` — auto-enabled, `ownerVisible: false`

**Records:** one `watcher` task @ wake.confirmed reading `RecentTaskStatesProvider.summarize`. Threshold: 3 days quiet. Surfaces "you've been quiet for N days" / "missed yesterday's check-in" observations into the morning-brief consolidation.

**Why in:** journey J5 — without this, an inactive user accumulates failed reminders silently and the morning brief never explains what happened. The watcher is `ownerVisible: false` so it doesn't add to the nudge count; its observations are folded into the morning brief.

**Day-one experience:** invisible until the user has been quiet 3+ days, then the morning brief includes a one-line acknowledgement. No standalone notification.

### `followup-starter` — auto-enabled, `ownerVisible: false`

**Records:** one `watcher` task @ wake.confirmed reading `RelationshipStore.list({ cadenceOverdueAsOf: now })`. Emits child `kind: "followup"` tasks per overdue edge with `subject = { kind: "relationship", id }` and `completionCheck.kind = "subject_updated"`.

**Why in:** GAP §3.13 — the follow-up watcher must be a `ScheduledTask` (not a separate cron service). Cadence lives on the edge so different relationships to the same person can have different cadences. The child tasks resolve automatically when any new interaction is observed on the edge.

**Day-one experience:** silent on day one (no relationships have a cadence yet). Once the user adds a cadence-bearing relationship and lets it lapse, a followup nudge appears in the morning brief.

### `inbox-triage-starter` — auto-enabled IF Gmail connector is present

**Records:** one `recap` task @ 9am owner-local (cron). `requiredCapabilities: ["google.gmail.read"]`.

**Why in:** journey: the most universal asynchronous pain point. If the user has Gmail connected, a daily 9am morning email triage is high-value with low risk. If Gmail isn't connected, the pack is **offered** at customize time but not auto-seeded — `getDefaultEnabledPacks({ connectorRegistry })` filters it out via `isInboxTriageEligible`.

**Day-one experience:** if Gmail is connected, one 9am triage. Otherwise, nothing — no error, no nag — until the user connects it.

### `habit-starters` — **offered**, not auto-enabled

**Records:** 8 habit seeds (brush teeth, shower, invisalign, drink water, stretch, vitamins, workout, shave). Stretch uses `first_deny` multi-gate composition: `[weekend_skip, late_evening_skip, stretch.walk_out_reset]` per IMPL §3.4.

**Why in (but not auto-enabled):** GAP §2.4 — habit-starters are the existing 8-template `seed-routines.ts` corpus. These work well _when chosen_, but auto-seeding 8 reminders into a fresh agent is overwhelming. We keep the pack so the user can pick (`first-run customize`); we set `defaultEnabled: false` so the defaults path skips it. The legacy `seed-routines.ts` is preserved as a transitional alias to keep `service-mixin-definitions.ts` and `client-lifeops.ts` callers green; Wave-2 W2-A migrates them to `ScheduledTaskRunner`.

**Workout pipeline placeholder:** `pipeline.onComplete: []` is the empty slot W2-F's BlockerRegistry will populate with the "release workout-blocker on completion" follow-up. Wave-1 ships the empty array so the field shape is stable.

**Day-one experience:** nothing. Customize lists the 8 options; the user picks.

## Consolidation policies

- `wake.confirmed` → `{ mode: "merge", sortBy: "priority_desc" }`. Closes journey J15. Ensures gm + morning-brief + sleep-recap (from plugin-health) + quiet-watcher and followup-watcher observations all render as one cohesive read instead of N notifications. Sort by priority so the morning-brief (`medium`) leads, gm (`low`) trails.
- `bedtime.target` → `{ mode: "sequential", staggerMinutes: 5 }`. Ensures gn (`low`) and plugin-health's sleep-recap don't arrive at the same instant; sequential is gentler than merge for end-of-day cognition.

## Default escalation ladders

Frozen by `wave1-interfaces.md` §3.4:

```
priority_low_default:    { steps: [] }
priority_medium_default: { steps: [{ delayMinutes: 30, channelKey: "in_app", intensity: "normal" }] }
priority_high_default:   { steps: [
  { delayMinutes: 0,  channelKey: "in_app",   intensity: "soft" },
  { delayMinutes: 15, channelKey: "push",     intensity: "normal" },
  { delayMinutes: 45, channelKey: "imessage", intensity: "urgent" },
]}
```

The W1-A spine consults these when a `ScheduledTask` lacks an explicit `escalation`. W1-D ships the data; W1-A's `escalation.ts` consumes it.

## What's out (and why)

These were considered and explicitly rejected for Wave-1:

- **Goals / OKR check-ins** — orthogonal to the heartbeat. Belongs to a future `goals` pack.
- **News digests** — too easily noisy without per-user calibration; not in Wave-1 scope.
- **Workout reminder + blocker pipeline as defaultEnabled** — auto-seeding a high-priority workout reminder for a fresh user is invasive. Stays inside the offered-only `habit-starters`.
- **Hardcoded gn time** — gn fires on the bedtime anchor, never a fixed clock-time. The lint pass catches the slip if a curator drifts.

## Day-one nudge budget

A fresh user who picks defaults sees, in 24h:

1. **gm** at wake.confirmed (consolidated with morning-brief).
2. **morning-brief** at wake.confirmed (same consolidated message as gm).
3. **morning-checkin** at wake.confirmed +30 min.
4. **morning-checkin-followup** at +60 min IF the owner didn't reply.
5. **gn** at bedtime.target (consolidated with plugin-health's sleep-recap if registered).
6. **plugin-health sleep-recap** at bedtime.target (sequential 5 min after gn).

Total: **≤ 6 user-facing nudges per day** when all defaults are enabled and no opt-in packs (habit-starters, inbox-triage) are picked. Verified by `test/default-packs.smoke.test.ts`.

## Wave-3 review (W3-A)

W3-A reviews this corpus after live user feedback:

- Adjust the quiet-user threshold based on observed behavior.
- Add `maxBatchSize` to the `wake.confirmed` consolidation policy if morning batches grow.
- Tune `priority_medium_default`'s 30-min retry if it feels too noisy or too lax.
- Consider promoting `inbox-triage-starter` to opt-out (default-on with one-question check) if the connection rate is high.
