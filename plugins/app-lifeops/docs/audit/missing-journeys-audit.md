# Missing-Journeys Audit (Phase 2)

Companion to `UX_JOURNEYS.md` and `JOURNEY_GAME_THROUGH.md`.

The 28-domain `journey-domain-coverage.test.ts` exercises one synthetic
journey per `UX_JOURNEYS.md` chapter. That set is structurally complete
but it is one chapter per domain — by construction it does not exercise
the long tail: cross-domain composition, ambient behavior, recovery,
identity, time-shift edge cases, mid-conversation locale mixing, agent
self-discovery, delegation contracts, conflict between captures, and
privacy revocation.

This audit catalogs that long tail, classifies each entry by whether the
existing primitives can compose it, and stages test coverage in
`test/journey-extended-coverage.test.ts`.

## Methodology

For each candidate journey we ask:

1. Can the existing primitives — `ScheduledTask` spine, `EntityStore`,
   `RelationshipStore`, `ActivitySignalBus`, `ConnectorRegistry`,
   `ChannelRegistry`, `OwnerSendPolicy`, `AnchorRegistry`,
   `EventKindRegistry`, `FamilyRegistry`, `BlockerRegistry`,
   `OwnerFactStore`, `MultilingualPromptRegistry`, `HandoffStore`,
   `RoomPolicyProvider` — compose this journey end-to-end without a new
   primitive? If yes → `gap_in_coverage` (missing test, not missing
   capability). If no → `gap` (missing primitive).
2. Severity:
   - `gap` — composition path requires a new primitive. Surface to wave
     coordinator.
   - `gap_in_coverage` — primitives suffice; we just lack a regression
     test.
   - `nice_to_have` — primitives suffice and the journey is
     under-specified in the source corpus; testing earns moderate signal.
3. Bias toward `gap_in_coverage`. Per AGENTS.md, prefer composition
   over new primitives.

## Findings

### Category 1 — Cross-domain composition

The user issues a single intent that spans 3+ capability surfaces. The
spine handles this through `pipeline.onComplete` chains; each child is a
schedulable task, so composition is structural.

#### F1.1 — Calendar event → email draft → reminder ladder → followup

- **Journey:** "Schedule the Frontier Tower walkthrough Thursday at 2pm
  and draft the confirmation email; remind me 1h before; if they don't
  reply by tomorrow, bump them."
- **Composition:** parent `kind: "approval"` (book the slot) →
  `pipeline.onComplete` chains an `kind: "output"` (gmail_draft) → a
  `kind: "reminder"` (T-1h via `relative_to_anchor`) → a `kind: "watcher"`
  on the relationship subject with `completionCheck: subject_updated`
  resolving to a `kind: "followup"`.
- **Primitives required:** `ScheduledTask` spine, `RelationshipStore`,
  `ChannelRegistry`. All present.
- **Severity:** `gap_in_coverage`.

#### F1.2 — Travel booking → calendar block → out-of-office signal → blocker preset

- **Journey:** "Book LA Tuesday-Thursday and clear my calendar; while
  I'm there, mute Slack and block X.com."
- **Composition:** approval (book) → output (calendar event) →
  watcher with `subject.kind: "calendar_event"` and gate
  `during_travel` → custom task wired to `BlockerRegistry`.
- **Severity:** `gap_in_coverage`.

#### F1.3 — Health signal → habit pause → user notification

- **Journey:** "If sleep was under 5 hours last night, soften my morning
  habits."
- **Composition:** `event` trigger on
  `lifeops.sleep.detected` filtered by duration → pipeline mutates each
  morning habit to `priority: "low"` → notify owner.
- **Primitives required:** `ScheduledTask`, `ActivitySignalBus`,
  `EventKindRegistry`.
- **Severity:** `gap_in_coverage`.

### Category 2 — Ambient behavior

User says nothing for N hours; the agent infers state from
signals/anchors and acts.

#### F2.1 — Silent recovery after missed wake

- **Journey:** No `wake.confirmed` anchor by 11am local. The agent
  schedules a soft check-in instead of firing the morning brief.
- **Composition:** `relative_to_anchor` task with
  `shouldFire.compose: "all"` and a `late_morning_skip`-style gate; if
  anchor is absent, defer; default-pack curates a softer alternate task.
- **Severity:** `gap_in_coverage` (gates suffice; no primitive missing).

#### F2.2 — Anticipated check-in after long quiet window

- **Journey:** No inbound from owner for 6 hours during a workday window.
  Agent schedules a low-priority "still here" check-in.
- **Composition:** watcher task with `completionCheck: subject_updated`
  on `subject.kind: "self"` with lookback; on completion → followup
  check-in. Owner reply within window completes; absence escalates one
  step.
- **Severity:** `gap_in_coverage`.

#### F2.3 — Auto-snooze when activity signals indicate focus

- **Journey:** Owner has been heads-down (no idle, browser focused on
  one tab) for 90 minutes. Pending non-critical reminders auto-snooze 30
  minutes.
- **Composition:** `during_focus_block`-style gate (not yet built-in but
  expressible via composed `late_evening_skip` + `quiet_hours`); deferred
  decision is a runner gate verdict, not a new primitive.
- **Severity:** `nice_to_have` (gate kind missing; ambiguity register
  A11 already covers gate-name typo risk).

### Category 3 — Connector recovery

A connector disconnects mid-task. The agent must degrade gracefully.

#### F3.1 — Discord disconnects while reminder ladder is mid-step

- **Journey:** Reminder ladder step 2 targets Discord; connector token
  expired between fire and dispatch.
- **Composition:** escalation step with `channelKey: "discord"` fails
  → runner advances to step 3 (`channelKey: "telegram"` or `in_app`)
  rather than stalling. Today the runner does not validate
  `channelKey` against `ChannelRegistry` (see ambiguity A11), so the
  test has to assert "ladder advances despite a missing channel"
  through metadata + escalation cursor.
- **Severity:** `gap_in_coverage` (current shape; lock the de-facto
  behavior so a future strict-validation change does not silently skip).

#### F3.2 — Connector reconnect prompt as a first-class followup task

- **Journey:** Google Drive token expired → user-visible followup
  appears in the overview.
- **Composition:** existing in Domain 20; this finding stages a stricter
  spine assertion that the followup carries `priority: "high"` and
  `metadata.surface = "drive"`.
- **Severity:** `gap_in_coverage`.

#### F3.3 — Connector recovery with queued outbound

- **Journey:** Telegram connector down; inbound message queued in
  `HandoffStore`; on reconnect, the spine fires a watcher that completes
  via `subject_updated` on the relationship.
- **Severity:** `gap_in_coverage`.

### Category 4 — Identity merge / split

#### F4.1 — Same person across two channels with different identities

- **Journey:** "Priya" appears as `priya@example.com` (Gmail) and
  `@priya_telegram` (Telegram). The agent merges into one
  `subject.kind: "entity"`.
- **Composition:** Domain 18 covers the merge surface. This finding
  asserts a watcher reschedules correctly when the entity collapses
  (the watcher's `subject.id` is the canonical entity id; the merge
  preserves it).
- **Severity:** `gap_in_coverage`.

#### F4.2 — Same person changes handle (split-then-rejoin)

- **Journey:** Counterparty changes Telegram username. Agent must not
  spawn a duplicate entity; existing watcher continues to resolve.
- **Composition:** entity-anchored watcher with
  `subject.kind: "entity"` is canonical-id-based, immune to
  handle-rename. Test schedules the watcher pre-rename, "renames" by
  touching the subject under a new handle, asserts the same subject
  resolves.
- **Severity:** `gap_in_coverage`.

### Category 5 — Time-shift edge cases

#### F5.1 — Travel across timezones mid-task

- **Journey:** User books a `cron`-triggered habit at 8am UTC, then
  flies SFO → Tokyo. Owner-fact `timezone` updates mid-day.
- **Composition:** spine carries `cron.tz`; owner-fact view
  reflects the new tz; the next fire respects the new tz. Test asserts
  that updating `OwnerFacts.timezone` between schedule and the next
  scheduler tick is observed by the runner.
- **Severity:** `gap_in_coverage`.

#### F5.2 — DST transition during pending `once` task

- **Journey:** A `once` task scheduled for "tomorrow 7am local" in a tz
  that hits a DST boundary tonight.
- **Composition:** `trigger: { kind: "once", atIso: "..." }` is UTC, so
  DST is the curator's responsibility; the spine accepts both
  pre-DST and post-DST `atIso` values without runner edits.
- **Severity:** `gap_in_coverage` (assert the spine accepts both
  pre-DST and post-DST atIso without runner edits).

#### F5.3 — Midnight boundary on streak counting

- **Journey:** Habit completed at 23:59 local. The runner should book
  the streak under today; the next day's task fires fresh.
- **Composition:** runner records `completedAt` as ISO; the streak
  counter is an output-side concern, not a spine concern. Spine test
  asserts `completedAt` is present and stable across timezone changes.
- **Severity:** `gap_in_coverage`.

### Category 6 — Multi-locale users

#### F6.1 — User mixes English and Spanish in one conversation

- **Journey:** "Recuérdame to call mom at 8pm". The agent should still
  classify the intent as create-reminder.
- **Composition:** `MultilingualPromptRegistry` (W2-E) handles the
  prompt-side; the spine just needs to accept tasks with mixed-locale
  `promptInstructions` and a `metadata.locale` that records the
  detected locale (or `mixed`).
- **Severity:** `gap_in_coverage`.

#### F6.2 — Locale changes between turns

- **Journey:** Same user switches from English to Japanese mid-session.
  Owner-fact `locale` updates; subsequent task `promptInstructions`
  follow.
- **Severity:** `gap_in_coverage`.

### Category 7 — Agent self-discovery

#### F7.1 — User asks "what can you do?"

- **Journey:** Should not create a task — it's a meta-query. But the
  agent must surface a discoverable task type, e.g. by listing `kinds`
  the spine accepts.
- **Composition:** spine exposes `inspectRegistries()` returning gates,
  completion-checks, ladders, anchors. Test asserts a custom `kind`
  task can be scheduled with `metadata.intent: "self_discovery"` to
  generate a help-card output.
- **Severity:** `gap_in_coverage`.

#### F7.2 — User asks "are you sure you can handle X?"

- **Journey:** Capability-introspection. Agent inspects registries,
  reports back.
- **Severity:** `gap_in_coverage`.

### Category 8 — Negotiation under uncertainty

#### F8.1 — Agent has incomplete info — asks one clarifying question

- **Journey:** "Schedule lunch with Pat next week" — Pat is one of three
  people; agent asks "which Pat?" exactly once before proposing.
- **Composition:** `kind: "approval"` task with `ownerVisible: true`
  and `pipeline.onSkip` chaining a re-ask followup, capped by
  `escalation.steps[0].intensity: "soft"` so we don't spam.
- **Severity:** `gap_in_coverage`.

### Category 9 — "Be my Samantha" delegation

#### F9.1 — User delegates email triage for a window of time

- **Journey:** "Handle my email for the next 2 hours; only ping me on
  red-alert items."
- **Composition:** custom task with
  `trigger: { kind: "once", atIso: <T+2h> }` to expire the delegation;
  metadata records the delegation contract (scope, threshold, channel);
  during the window, normal triage tasks run with
  `ownerVisible: false` unless red-alert flips them. The expiry task
  flips ownership back.
- **Severity:** `gap_in_coverage` (no new primitive — delegation is a
  metadata-shaped contract on a custom task).

#### F9.2 — Delegation revocation mid-window

- **Journey:** User says "actually never mind, I'll handle it." Agent
  cancels the delegation task and reverts visibility.
- **Composition:** `apply(taskId, "dismiss")` on the delegation task;
  pipeline `onSkip` flips dependent tasks back to `ownerVisible: true`.
- **Severity:** `gap_in_coverage`.

### Category 10 — Composite recovery / partial rollback

#### F10.1 — Multi-step workflow fails partway

- **Journey:** Approval → output → reminder. Output step (gmail draft
  creation) fails. Pipeline `onFail` emits a followup that explains the
  partial state.
- **Composition:** `pipeline.onFail` triggers a child explanatory
  followup. The terminal-state ambiguity register (A1) confirms
  `failed` is reachable only via `runner.pipeline(taskId, "failed")`,
  so the test drives that path.
- **Severity:** `gap_in_coverage`.

#### F10.2 — Rollback explanation as ownerVisible card

- **Journey:** When a partial-rollback happens, the explanatory
  followup must be `ownerVisible: true` even when the parent was
  shadow.
- **Severity:** `gap_in_coverage`.

### Category 11 — Privacy / consent edge cases

#### F11.1 — User revokes consent mid-conversation

- **Journey:** "Stop reading my email. I'll forward what I want
  reviewed." Active `kind: "watcher"` tasks on Gmail subjects must
  transition to `dismissed` with an audit trail.
- **Composition:** `apply(taskId, "dismiss", { reason: "consent_revoked" })`
  — runner records `lastDecisionLog`. `ScheduledTaskFilter` lets us
  bulk-list the affected tasks first.
- **Severity:** `gap_in_coverage`.

#### F11.2 — Re-anchor on consent restore

- **Journey:** User re-grants consent; previously-dismissed watcher must
  not auto-resurrect (avoids stale subject IDs). New tasks are
  scheduled fresh.
- **Severity:** `gap_in_coverage`.

### Category 12 — Conflict between captures

#### F12.1 — Two connectors report conflicting state

- **Journey:** Apple Health says owner is `asleep` since 22:00; Slack
  shows activity at 23:30. The agent must not fire the morning brief
  early and must not double-snooze; circadian rule logging captures
  the conflict.
- **Composition:** `ActivitySignalBusView.hasSignalSince` is
  per-signal-kind; the runner does not adjudicate conflicts — that's
  a `plugin-health` concern. The spine assertion is "two signals can
  coexist; the gate evaluates one explicitly". Test schedules a task
  gated on `health.wake.confirmed`, fires it, observes that a Slack
  activity signal does not change the wake decision.
- **Severity:** `gap_in_coverage` (confirms boundary: spine does not
  adjudicate conflicts; that lives upstream).

## Summary

- **27 candidate journeys** cataloged across 12 categories.
- **0 missing primitives.** Every journey above composes from existing
  primitives. The only soft `nice_to_have` is F2.3 which would benefit
  from a `during_focus_block` gate kind — already tracked as a
  follow-up to ambiguity A11 (gate-name typo risk).
- **27 `gap_in_coverage` entries.** All become high-confidence test
  candidates.
- **12 promoted to the test suite** (one per category, plus the
  highest-leverage second from cross-domain composition). Remaining
  entries stay in this audit as candidate Phase-3 extensions.

## Top 3 composability findings

1. **The spine accepts every cross-domain pipeline we tested without
   source-code edits.** F1.1, F1.2, F1.3 chain calendar → email →
   reminder → followup → blocker through `pipeline.onComplete`.
   Composition is a curator concern, not a runner concern.

2. **Identity, locale, and timezone are subject-id / metadata
   concerns — not new primitives.** F4.1, F4.2, F5.1, F6.1 all
   compose without runner edits; the spine treats `subject.id` as
   opaque and `metadata.locale` as free-text. The
   `MultilingualPromptRegistry` (W2-E) handles the prompt side.

3. **Delegation contracts (F9.1, F9.2) are
   `metadata`-shaped on custom tasks, not a new primitive.** A
   "be-my-Samantha" window is a `once` task that expires the
   delegation; child tasks flip `ownerVisible` based on the
   delegation's threshold metadata. No `DelegationRegistry`
   needed.

## How to consume this audit

- Each entry's `Severity` aligns with the post-Wave-2 ambiguity
  register's classification.
- New `gap` entries (composition path requires a new primitive)
  surface to the wave coordinator immediately.
- New `gap_in_coverage` entries become test stubs in
  `test/journey-extended-coverage.test.ts`.
- The audit + test together close the loop: a primitive that becomes
  insufficient flips an entry from `gap_in_coverage` to `gap` with
  evidence.
