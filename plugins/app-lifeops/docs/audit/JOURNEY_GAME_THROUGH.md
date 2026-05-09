# LifeOps — End-to-End Journey Game-Through Against Proposed Architecture

**Companion to:** `UX_JOURNEYS.md`, `GAP_ASSESSMENT.md`, `IMPLEMENTATION_PLAN.md`, `HARDCODING_AUDIT.md`.

**Purpose:** simulate ~18 representative user journeys step-by-step against the proposed architecture (`ScheduledTask` spine + supporting registries + `plugin-health` extraction + first-run capability + connector contract) and surface every architectural gap, ambiguity, latency cost, state-management question, or "this doesn't actually work end-to-end" issue.

**Date:** 2026-05-09.

**Method:** for each journey, walk every user step and every system step. At each system step, ask: which action does the planner pick? does it exist? what does it emit? where does state live? what does the user see? what does the next step depend on? how many LLM round-trips? what fails silently?

**Notation:**
- *Plan ref* — section number in `IMPLEMENTATION_PLAN.md` (IMP) or `GAP_ASSESSMENT.md` (GAP).
- *spec-undef* — the architecture is silent on this step. Hard finding.
- *spec-bad-ux* — the spec defines this but the user experience would be poor. Soft finding.
- *latency cost* — counted as **L = LLM round-trip** (planner extraction or generation, ~500 ms–2 s) and **S = sync wait** (network/DB/connector dispatch, ~50–500 ms).

---

## Journey 1: First-run defaults path

**Source:** UX_JOURNEYS.md §1.1–§1.2; GAP §5.3 path A; IMP §3.3 W1-C.

**Pre-conditions:** fresh install, no `OwnerFactStore` data, no `ScheduledTask` records, no connectors paired, default packs registered at plugin init.

**Step-by-step trace:**

| # | Actor | Action / Event | Architecture component | Notes |
|---|---|---|---|---|
| 1 | User | Opens Eliza, types "hi" or "what can you do?" in chat | inbound-message → planner | Provider runtime context assembly. |
| 2 | System | First-run provider runs (position TBD) | `providers/first-run.ts` (W1-C) | Surfaces affordance "first-run not yet completed". *Spec-undef:* what exact context string is injected? Single line, structured affordance object, or both? IMP §3.3 says "one short line" but doesn't specify the contract for "this is an affordance the LLM should pick up". |
| 3 | System | Planner extracts intent | LLM call (1 L) | The planner is now expected to pick `FIRST_RUN` action because the affordance was surfaced. *Spec-undef:* what if the user just said "hi"? Does first-run become a forced action, or does the LLM have discretion? Forced = first-run hijacks the conversation; discretion = first-run might never run. |
| 4 | System | `FIRST_RUN` action invoked with `path = ?` | `actions/first-run.ts` (W1-C) | *Spec-undef:* the action signature. GAP §5 says "two paths" but the agent has to decide between them. Three options: (a) the action prompts the user immediately ("want defaults or 5 questions?") - adds 1 L round-trip; (b) the planner pre-selects path from the user's utterance; (c) the action defaults to "defaults" and the user can re-run for customize. The spec doesn't pick. |
| 5 | User | Replies "just give me the defaults" | inbound | |
| 6 | System | Action dispatches to `defaults.ts` | `lifeops/first-run/defaults.ts` | Reads pack manifest for the curated default set. |
| 7 | System | Resolves anchors / windows | `OwnerFactStore` interim wrapper + stub anchor resolver | *Spec-bad-ux:* `morning = 06:00–11:00` and `evening = 18:00–22:00` are hardcoded defaults if user said nothing. Means `gm` reminder fires at 06:00 day one — most users do not wake at 06:00. IMP §3.3 acknowledges this but doesn't propose a mitigation (e.g. "ask about wake time even on defaults path"). |
| 8 | System | Creates `ScheduledTask` records (gm, gn, daily check-in, morning brief stub) | `ScheduledTaskRunner.schedule(...)` (W1-A) ×4+ | DB writes. 4–6 S. |
| 9 | System | Registers default time windows | `OwnerFactStore` write (interim) | *Spec-undef:* IMP §3.3 says "four standard windows + three meal windows", but the meal-window boundaries (breakfast = ?, lunch = ?, dinner = ?) aren't defined. |
| 10 | System | Sets default channel = `in_app` on user profile | `OwnerFactStore` write | *Spec-undef:* what if the user opened the conversation through Telegram? The channel registry was never consulted to verify `in_app` even applies for users who don't open the dashboard. |
| 11 | System | Marks first-run completed | `lifeops/first-run/state.ts` write | |
| 12 | System | Returns confirmation message | LLM call (1 L) for the response render | "Defaults applied — you'll get a morning ping at 6am, an evening ping at 10pm, and a check-in at 9am." |
| 13 | User | Sees the message | | First-run provider goes silent on next turn. |
| 14 | System | (Next morning, 06:00) | runner timer | gm `ScheduledTask` fires. *Spec-undef:* what's the user's surface? Push? In-app card? Discord DM? — depends on whether the `in_app` default has a real notification channel registered. If user closed the app, `in_app` notification is invisible. |

**What works in the proposed architecture:**
- The provider/action shape mirrors the existing `enabled_skills` pattern (low risk).
- `ScheduledTask` spine cleanly absorbs the seeded entries.
- Re-entry contract (re-invoke = no-op or "merge new answers") is acknowledged in IMP §3.3 verification step.

**Gaps / ambiguities found:**
1. **No defined affordance schema.** The provider returns "first-run not yet completed" but the data shape isn't specified. Without it, integration tests can't assert the planner actually saw the affordance.
2. **Path-selection mechanism is undefined.** Action signature for "which path" is missing; in-action prompt vs planner pre-selection is a real UX fork.
3. **"Default morning = 06:00–11:00" is hostile.** Most owners don't wake at 06:00. Path A explicitly skips asking about wake time, but firing gm at 06:00 day one will train users to disable LifeOps.
4. **Default channel `in_app` only works in-app.** Users coming in through DM connectors get no nudge until they open the dashboard.
5. **Meal-window boundaries undefined.** Default vitamins/lunch tasks reference `lunch` window but the start/end aren't specified.
6. **First fire latency is 6+ hours minimum.** The user does first-run, then sees nothing until next morning. No "here's what's scheduled" visualization is in the plan.

**Latency budget:**
- 2 L (planner extract + response render). 4–6 S (writes). ~1.5–3 s wall-clock for the action; the user-perceived "agent feels alive" wait is ~1 day until the first fire.

**Failure modes:**
- If `plugin-health` isn't registered at boot, `wake.confirmed` anchor doesn't resolve. The morning brief stub falls back to the stub time. Silent.
- If a default-pack contribution throws during registration, the entire first-run output is non-deterministic — no plan section says how packs fail-fast.
- If two default packs both register a task with `key = "gm"`, no dedupe is specified.

**Dependencies on undefined components:**
- The planner-affordance protocol (how providers surface "the LLM should know about this action"). Existing `enabled_skills` is referenced but not contractually adapted.
- The `in_app` notification channel (referenced by name but no `ChannelRegistry` entry is mandatory in Wave 1; that's W2-B).
- The meal-window content.

---

## Journey 2: First-run customize path

**Source:** UX_JOURNEYS.md §1.2–§1.5; GAP §5.3 path B; IMP §3.3 W1-C, IMP §8.1.

**Pre-conditions:** fresh install. User decides to answer questions.

**Step-by-step trace:**

| # | Actor | Action / Event | Architecture component | Notes |
|---|---|---|---|---|
| 1 | User | "Set me up properly" | planner | |
| 2 | System | Planner picks `FIRST_RUN` action with `path = "customize"` | LLM (1 L) | *Spec-undef:* what utterances trigger customize vs defaults? The action signature isn't pinned. |
| 3 | System | Q1: "What should I call you?" | `questions.ts` (W1-C) emits prompt | LLM render (1 L). |
| 4 | User | "Shaw" | | |
| 5 | System | Persists `ownerFact.preferredName = "Shaw"` | `OwnerFactStore` interim wrapper | 1 S. |
| 6 | System | Q2: "Time zone + morning/evening windows?" | LLM render (1 L) | |
| 7 | User | "Denver, mornings around 8, evenings till 11" | | |
| 8 | System | Parses tz + windows from natural language | LLM extract (1 L) | *Spec-undef:* what extractor? The plan doesn't specify whether questions.ts contains its own LLM extractor or calls a generic. |
| 9 | System | Persists `tz, morningWindow, eveningWindow` | OwnerFactStore | 1 S. |
| 10 | System | Q3: multi-select categories | LLM render (1 L) | *Spec-undef:* multi-select via natural language ("yes to sleep tracking and reminders, no to inbox") requires another extractor pass. |
| 11 | User | "sleep tracking and reminders" | | |
| 12 | System | Parses categories | LLM extract (1 L) | |
| 13 | System | If `sleep tracking` → schedules `plugin-health` connector offer as a follow-up step | *spec-undef* | IMP §8.1 explicitly flags this as an open question: "should category cascade automatically into ConnectorRegistry offers?" The W1-C spec doesn't decide. |
| 14 | System | Q4: notification channel | LLM render (1 L) | |
| 15 | User | "telegram" | | |
| 16 | System | Validates Telegram connector exists | `ChannelRegistry`? Or `OwnerFactStore` blind write? | *Spec-undef:* if Telegram isn't connected yet, do we ask to connect now, or write the preference and trust the validation later? |
| 17 | System | Q5 (skipped — user didn't pick follow-ups) | | |
| 18 | System | Creates default-pack `ScheduledTask` records keyed to user's answers | `ScheduledTaskRunner.schedule` ×N | 4–6 S writes. |
| 19 | System | Marks first-run done | OwnerFactStore | 1 S. |
| 20 | System | Confirmation render | LLM (1 L) | |

**What works in the proposed architecture:**
- The Q1–Q5 sequence is well-contained in `questions.ts`.
- Wave 1 ships an interim wrapper around `LifeOpsOwnerProfile`, deferring the OwnerFactStore generalization to Wave 2 — bounded scope.

**Gaps / ambiguities found:**
1. **Question budget vastly underestimated.** GAP §5.3 says "under 90 seconds for a user who answers tersely". The trace shows **6+ LLM round-trips** (questions + answers + extraction). Each round-trip is ~1–3 s. Realistic budget is 2–4 minutes for a verbose answerer.
2. **No category-to-connector cascade contract.** IMP §8.1 explicitly leaves this open. If a user says "sleep tracking", does the action then enter the connector flow inline, or does it just store a flag and surface the offer later? Different UX.
3. **No fallback for "user typed nothing useful for question X".** What if user says "skip" or just types "ok"? Re-ask? Default? Continue?
4. **No abandon path.** What happens if user closes the app mid-questions? Spec doesn't say. The state store should record partial progress but no spec for resume.
5. **No back-and-edit.** User can't say "wait, change my time zone" mid-sequence — there's no in-flow editing path.
6. **Q4 channel validation gap.** If the channel isn't connected, the customize path silently writes a preference that won't fire reminders. The user sees their first task fire at the wrong channel a day later.
7. **Spanish/multilingual re-entry is undefined.** Customize-path examples are in English. If `MultilingualPromptRegistry` isn't ready in Wave 1 (it's W2-E), the Spanish user can't customize.

**Latency budget:**
- 7 L extractions / generations over ~5 conversational turns. ~5–15 s system time + ~10 s user thinking time per question. Wall clock: 2–4 minutes.

**Failure modes:**
- LLM extracts the wrong tz from "Denver, mornings around 8" — silently writes `America/Denver` but interprets `morningWindow = 08:00–08:00`. No UX feedback.
- User says "morning around 8" expecting 08:00; extractor stores 08:00; gm fires at 08:00 sharp. User wanted "around" = window. Spec doesn't define how tolerant the parse is.
- If `OwnerFactStore` interim wrapper has a different schema than the real store (W2-E), Wave-2 swap breaks customize state.

**Dependencies on undefined components:**
- `ConnectorRegistry`-cascade behavior (IMP §8.1).
- The "abandon and resume" state machine for first-run (no plan section).
- A multilingual fallback path (W2-E hasn't landed yet).

---

## Journey 3: Author a habit from chat — "remind me to take vitamins with lunch every weekday"

**Source:** UX_JOURNEYS.md §3.12; GAP §2.3, §3 (gates registry); IMP §3.1 W1-A.

**Pre-conditions:** first-run done, lunch window registered, planner has `SCHEDULED_TASK` umbrella.

**Step-by-step trace:**

| # | Actor | Action / Event | Architecture component | Notes |
|---|---|---|---|---|
| 1 | User | "remind me to take vitamins with lunch every weekday" | planner | |
| 2 | System | Planner extracts intent | LLM (1 L) — picks `SCHEDULED_TASK.create` umbrella per GAP §8.3 | *Spec-undef:* the parameter schema for `create`. GAP §2.3 shows the `ScheduledTask` shape but the planner has to emit it in a single extraction. Today's `extractTaskCreatePlan` produces `LifeOpsCadence`; not the same shape as the spine's `trigger`. |
| 3 | System | Maps `weekday + lunch` → `trigger.kind = "during_window"` with `windowKey = "lunch"` and `shouldFire.kind = "weekday_only"` | extractor + W1-A built-in gate | *Spec-undef:* `weekday_only` isn't in IMP §3.1's listed gate set (`weekend_skip, late_evening_skip, quiet_hours, during_travel`). User said "weekday" → planner has to negate `weekend_skip`, but that's awkward. |
| 4 | System | Persists `ScheduledTask` | DB write (1 S) | |
| 5 | System | Renders preview/confirm reply | LLM (1 L) | "Got it — vitamins at lunch on weekdays. Confirm?" |
| 6 | User | "yes" | | |
| 7 | System | Planner routes "yes" — to which action? | *Spec-undef* | Currently `extractTaskCreatePlan` has a preview/confirm flow with state in conversation history. With the spine, the task is already persisted before confirm, so "yes" is racey. Or the spine creates `status=draft` first and the second extract flips to `status=scheduled`. Plan doesn't specify. |
| 8 | System | Confirmation reply | LLM (1 L) | |
| 9 | System | (Next weekday at 12:00) | runner | task fires. |
| 10 | System | Reminder dispatched via `in_app` (or whatever channel was set in first-run) | escalation evaluator + `ChannelRegistry` (W1 stub, W2-B real) | |
| 11 | User | Sees the reminder, takes vitamin, taps "done" | | |
| 12 | System | `SCHEDULED_TASK.complete` | runner verb | state → `completed`. |
| 13 | System | (Next weekday) | next fire | repeats. |

**What works in the proposed architecture:**
- `times_per_day` / `daily` cadence is already covered in the existing `LifeOpsCadence`; the spine's `trigger.kind = "during_window"` is a clean superset.
- The "ScheduledTask is data, not code" principle means brushing teeth, taking vitamins, drinking water all collapse to records.

**Gaps / ambiguities found:**
1. **Gate kind set is incomplete.** IMP §3.1 lists 4 gates; common cases like `weekday_only`, `weekend_only`, `holiday_skip`, `during_focus_block` aren't enumerated. *spec-undef* whether these are part of Wave 1, default-pack contributions (W1-D), or Wave 2.
2. **Preview/confirm state model with the spine is undefined.** Today's flow uses session memory + planner re-classification. With persisted `ScheduledTask`, the preview is either a draft row or a non-persisted intent. Plan §3.1 doesn't decide. If the user says "actually save it as 1pm" mid-flow, do we mutate or replace?
3. **Multi-attempt save (3.4 retry-after-cancel) state doesn't have a defined idempotency story.** If the user cancels then retries, the spine could end up with two records.
4. **The `weekly` and `weekday` semantics conflict.** "Every weekday" is `weekly with weekdays = [1..5]` in `LifeOpsCadence`. The spine's `trigger.kind = "during_window"` lacks a "weekdays" filter — there's no first-class weekday selector. Need either a new trigger kind (`weekly_during_window`) or compose with `shouldFire`.
5. **`mealLabel` isn't first-class on the trigger.** "With lunch" maps to a window, but "with breakfast" / "with dinner" same way. If meal windows aren't specified (Journey 1 Gap), this fails silently — fires at default lunch time.

**Latency budget:**
- 3 L (extract create + render + confirm render) + 1 S write. ~3–5 s wall clock per turn.

**Failure modes:**
- Planner mis-classifies "remind me to take vitamins with lunch" as `LIFE.create_definition` (legacy) instead of `SCHEDULED_TASK.create` (new) during the migration window. Both actions exist concurrently in Wave 1 (legacy reminder loop continues) — race for the same intent.
- Lunch window isn't registered → silent fire at default time.
- "Every weekday" interpretation drift: user means M–F, system stores `weekday_only` gate but that gate doesn't exist → all-day fire on weekends too.

**Dependencies on undefined components:**
- `weekday_only` gate kind.
- Preview/confirm state model on the spine.
- Idempotency on retry-after-cancel.

---

## Journey 4: GM / GN ScheduledTask firing daily

**Source:** UX_JOURNEYS.md §1, §4.5 wake/bedtime workflow scheduling; GAP §2.4 default packs; IMP §3.4 W1-D daily-rhythm pack.

**Pre-conditions:** first-run done with defaults; gm/gn tasks scheduled.

**Step-by-step trace:**

| # | Actor | Action / Event | Architecture component | Notes |
|---|---|---|---|---|
| 1 | System | (06:00) timer fires | `ScheduledTaskRunner` cron tick | |
| 2 | System | Runner evaluates trigger for gm task | trigger eval | `relative_to_anchor("wake.confirmed", 0)` or fixed cron `0 6 * * *`? IMP §3.1 says "stub anchors" in Wave 1 mapping `wake.confirmed = ownerFact.morningWindow.start`. So anchor resolves to 06:00. |
| 3 | System | Evaluates `shouldFire` gate | `TaskGateRegistry` | None on default gm. |
| 4 | System | Renders prompt → message | LLM (1 L) | The prompt is `promptInstructions: "Wish the user good morning."` Renders → "Good morning, Shaw!" |
| 5 | System | Channel dispatch | `ChannelRegistry` (W1 stub) → `in_app` notification | *Spec-undef:* if user is offline / app is closed / on a different device, what happens? |
| 6 | User | Sees notification, taps to acknowledge | UI sends `SCHEDULED_TASK.acknowledge` | |
| 7 | System | State → `acknowledged` | runner verb | 1 S. |
| 8 | System | Pipeline check | `pipeline.onComplete` | *Spec-undef:* is `acknowledged` the same as `completed` for pipeline triggers? GAP §2.3 lists both states separately but doesn't say which triggers `onComplete`. |
| 9 | User | (Ignores) | | |
| 10 | System | After N minutes, `completionCheck` fails (no ack) | escalation evaluator | *Spec-undef:* how long is the "no ack" window for a default gm? Not specified in IMP §3.4. |
| 11 | System | Escalation step 2 — push? | `escalation.steps[1]` | *Spec-undef:* default gm doesn't ship with an escalation ladder. The runner has to either default to "no escalation" or "single channel single attempt". Plan picks neither explicitly. |
| 12 | System | After full timeout, state → `expired` or `dismissed` | | *Spec-undef:* terminal state for "user just ignored gm". GAP §2.3 lists `dismissed | expired | failed` — the plan doesn't say which the runner picks for "no response, no ack". |
| 13 | System | Tomorrow 06:00 — repeat | | |

**What works in the proposed architecture:**
- The cron-or-anchor primitive is clean.
- Default packs ship with prompt + trigger; runner doesn't pattern-match content.

**Gaps / ambiguities found:**
1. **No "did user respond?" follow-up timeline on default gm.** User asked specifically about the followup-tracking behavior; the plan doesn't specify if/when gm escalates.
2. **Channel dispatch for offline users.** `in_app` is the default, but a user not in the app doesn't see it. Push fallback isn't specified.
3. **Acknowledged ≠ completed semantics is unclear.** GAP §2.3 has both states. Does tapping "good morning" → ack → completed? Or ack only → terminal? Pipeline depends on this.
4. **"Failed" terminal state conflict.** Did-nothing-happened should arguably be `dismissed`; spec uses `expired`/`dismissed`/`failed` interchangeably.
5. **No surface for "you've ignored gm 5 days in a row" feedback.** `followupCount` is a field on the task, but no plan section describes a meta-task that surfaces it.

**Latency budget:**
- 1 L (prompt render) + 1 S (channel dispatch). Sub-second user-perceived latency at fire time.

**Failure modes:**
- User on a different time zone post-trip. Anchor stub uses `ownerFact.morningWindow.start` which is now stale. gm fires at 06:00 absolute time, not local-time. Silent.
- Multiple devices: dispatch fires once but ack only on one device. Other devices keep showing the notification. Mitigation requires `LIFEOPS_REMINDER_CHANNELS.cross-device sync` (UX_JOURNEYS §7.8) which the plan doesn't lift to the spine.

**Dependencies on undefined components:**
- Default escalation ladder for gm (or explicit "no ladder" decision).
- Terminal-state policy for ignored fires.
- Cross-device acknowledgement.

---

## Journey 5: Daily check-in with followup tracking (the user's specific concern)

**Source:** UX_JOURNEYS.md §4.4 night/morning brief; GAP §2.4 daily-check-in; IMP §3.4 W1-D daily-rhythm pack.

**Pre-conditions:** first-run done, daily check-in `ScheduledTask` scheduled at 09:00 with `followupAfterMinutes = 30` (per GAP §2.3 default).

**Step-by-step trace:**

| # | Actor | Action / Event | Architecture component | Notes |
|---|---|---|---|---|
| 1 | System | (09:00) check-in fires | runner | |
| 2 | System | Renders prompt | LLM (1 L) | "How are you feeling today, Shaw?" |
| 3 | System | Dispatches via channel | ChannelRegistry | |
| 4 | User | (Responds) "Tired but ok" | inbound | |
| 5 | System | Planner classifies | LLM (1 L) | *Spec-undef:* what action does "tired but ok" route to? The check-in `ScheduledTask` doesn't auto-attach a `completionCheck` to inbound messages. The runner needs a "the user replied to this task's prompt" detector. |
| 6 | System | Detects this is a reply to the open check-in task | *Spec-undef* | The `completionCheck.kind = "user_replied_within"` is registered (IMP §3.1) but no plan section specifies how the runner correlates an inbound message with the open task. By room? By time window? By `inReplyTo`? |
| 7 | System | State → `completed` | runner | |
| 8 | System | Pipeline `onComplete` — none for default check-in | | |

**Alt path: user ignores.**

| # | Actor | Action / Event | Architecture component | Notes |
|---|---|---|---|---|
| 4' | User | (no response by 09:30) | | |
| 5' | System | Followup task fires | `pipeline.onSkip[0]` or `completionCheck.followupAfterMinutes` | *Spec-undef:* GAP §2.3 has both `pipeline.onSkip` (explicit composition) and `completionCheck.followupAfterMinutes` (implicit). Which one? Are they mutually exclusive? The plan doesn't pick. |
| 6' | System | Renders followup prompt | LLM (1 L) | "Still there, Shaw?" |
| 7' | User | (no response by 10:00) | | |
| 8' | System | What now? | *Spec-undef* | Plan does not specify a default escalation ladder for the daily check-in. Could be: another follow-up, a channel switch (push), or terminal dismiss. The user's specific question — "after how long is 'didn't check in' a state the system surfaces back?" — has no answer in the plan. |
| 9' | System | (Tomorrow 09:00) | next day | New check-in fires regardless of yesterday's state. |
| 10' | System | Aggregating "missed N check-ins in a row" | *Spec-undef* | No plan section describes a meta-surface that aggregates yesterday's `expired`/`dismissed` check-in state into today's prompt or into a separate "you've been quiet" task. |

**What works in the proposed architecture:**
- The `completionCheck.kind = "user_replied_within"` registry hook is the right shape.
- Daily-rhythm default pack puts this on Wave 1.

**Gaps / ambiguities found:**
1. **Inbound-message-to-task correlation is undefined.** The single biggest gap. The runner needs to know which task an inbound message replied to. Options: (a) a single "open prompt" per user; (b) a `replyToTaskId` channel parameter; (c) a planner classifier that reads context. None is specified.
2. **Pipeline.onSkip vs completionCheck.followupAfterMinutes overlap.** Two different mechanisms for "what to do if no response".
3. **Default check-in lacks an escalation policy.** "After how long is 'didn't check in' surfaced" has no answer.
4. **No meta-task aggregation.** "User has been quiet for 3 days" requires a watcher that reads `state.status === "expired"` across recent history. No plan section creates this watcher.
5. **Time-zone drift.** 09:00 cron in user's TZ assumed; if user travels mid-day, the next fire could be 09:00 absolute or 09:00 local. Not specified.

**Latency budget:**
- Active path: 2 L. Followup adds 1 L per attempt.

**Failure modes:**
- User responds to check-in 3 hours later. Was the task already `expired`? Their response then routes to... nothing? Or re-opens the task? Spec-silent.
- User replies "tired" via Telegram but check-in was sent via in_app. Cross-channel correlation fails silently.

**Dependencies on undefined components:**
- Inbound-to-task correlation.
- Aggregation surface for "quiet user" state.
- Time-zone-aware cron evaluation.

**Severity for user's specific concern:** High. The "did the user check in?" loop is one of the highest-leverage user-perceived behaviors and the plan has zero coverage for the multi-day aggregation.

---

## Journey 6: Pipelined draft → approve → send (Q3 update to colleague)

**Source:** UX_JOURNEYS.md §9.4–§9.5, §17.1; GAP §2.2 (draft pipeline → 3-task pipeline), §3.3 ApprovalQueue.

**Pre-conditions:** first-run done; Gmail connected (owner side); planner has `SCHEDULED_TASK` umbrella + `MESSAGE` umbrella.

**Step-by-step trace:**

| # | Actor | Action / Event | Architecture component | Notes |
|---|---|---|---|---|
| 1 | User | "Send the Q3 update to Pat by EOD" | planner | |
| 2 | System | Planner classifies | LLM (1 L) | *Spec-undef:* does this route to `MESSAGE.send` (current behavior), to `SCHEDULED_TASK.create` (with pipeline), or to `BOOK_TRAVEL`-style compound? GAP §2.2 says "draft-then-approve flow IS a 3-task pipeline" — implies SCHEDULED_TASK. But the planner has been trained against `MESSAGE`. |
| 3 | System | Resolves "Pat" via ContactResolver | `IdentityGraph` + `ContactResolver` | *Spec-undef in W1:* W2-D builds resolver. In Wave 1, resolution is by string match against existing contacts. Multiple Pats → ambiguous → 409. |
| 4 | System | Creates pipeline of 3 `ScheduledTask` records | runner ×3 | Task A (draft), Task B (approval), Task C (send). |
| 5 | System | Task A fires immediately | runner | LLM (1 L) — generates draft body. |
| 6 | System | Stores draft | *Spec-undef* | Where does the draft body live? `ScheduledTask.metadata.draftBody`? A separate `lifeops_drafts` table? The Gmail draft system (Gmail's `drafts.create`)? |
| 7 | System | Task A `onComplete` → fires Task B | runner pipeline | |
| 8 | System | Task B prompts user | LLM (1 L) | "Here's the draft for Pat — approve?" |
| 9 | User | (3 hours later) opens app, sees pending approval | UI surface for approval queue | *Spec-undef:* does the approval-task surface in `GET /api/lifeops/approval-queue` or in `GET /api/lifeops/scheduled-tasks?completionCheck.kind="user_approved"`? GAP §3.3 says the approval queue IS the listing for approval-typed tasks, but GAP §2.7 also says approval queue "is the service that lists outstanding approval-typed `ScheduledTask` records" — implying these are unified. Endpoint contract not specified. |
| 10 | User | "approve" or "edit before sending: change EOD to noon Friday" | | |
| 11 | System | Edit before approve handling | *Spec-undef* | Three options: (a) cancel Task B, re-fire Task A with edits → new draft; (b) mutate the draft in place; (c) require approve-then-edit-then-send via separate verb. Plan doesn't pick. |
| 12 | System | Task B `onComplete` → fires Task C | runner pipeline | |
| 13 | System | Task C dispatches Gmail send | `ConnectorRegistry.gmail.send` (W2-B) | 1 S. |
| 14 | System | State → `completed` | | |

**What works in the proposed architecture:**
- 3-task pipeline cleanly maps to draft/approve/send.
- ApprovalQueue + ApprovalResolverRegistry (GAP §3.3) is a clean replacement for the hardcoded `executeApprovedBookTravel` import.

**Gaps / ambiguities found:**
1. **Draft body persistence is undefined.** Three plausible locations.
2. **Edit-before-approve is undefined.** Common case; spec silent.
3. **Approval queue + ScheduledTask listing duplication.** Two endpoints might surface the same data; relationship not specified.
4. **3-hour pause behavior.** If the user waits 3 hours, does Task B `expire`? Plan §3.1 has the lifecycle but no default expiry policy for approval tasks.
5. **Pipeline re-trigger on edit.** If edit re-fires Task A, the draft is regenerated — different content than the user reviewed. UX hazard.
6. **No "draft is stale" detection.** If 3 hours later the calendar has changed (new conflict, new info), the draft is now wrong. Spec silent.
7. **Connector outage during Task C.** Gmail dispatcher returns error → Task C → `failed`. Pipeline `onFail` is empty by default. User sees nothing? See Journey 17.

**Latency budget:**
- Authoring path: 1 L (planner) + 1 L (draft generation) + 1 L (approval prompt render) ≈ 3 L. ~5–8 s before user sees the draft.
- Approve + send path: 1 L (planner classifies "approve") + 1 S (gmail send). ~2 s.
- Edit-and-approve: 4–5 L total.

**Failure modes:**
- Pat resolves ambiguously (multiple Pats) — Task A draft is generic; Task B approval has wrong recipient; user approves and sends to wrong Pat. Resolver confidence isn't propagated to approval surface.
- Gmail OAuth expired — Task C fails; default `onFail` is empty; user never knows.
- User approves on phone but draft was generated with desktop context — content mismatch invisible.

**Dependencies on undefined components:**
- Draft persistence schema.
- Edit-before-approve protocol.
- Approval task / approval queue unification.

---

## Journey 7: Reactive task on calendar event end (meeting → recap)

**Source:** UX_JOURNEYS.md §26.2; GAP §2.3 trigger.kind = "event"; IMP §3.4 (calendar.event.ended is a known kind).

**Pre-conditions:** Google Calendar connected, user authored "after every meeting send me a recap" task.

**Step-by-step trace:**

| # | Actor | Action / Event | Architecture component | Notes |
|---|---|---|---|---|
| 1 | User | (some prior turn) "after every meeting send me a recap" | planner → SCHEDULED_TASK.create | |
| 2 | System | Creates `ScheduledTask` with `trigger = { kind: "event", eventKind: "calendar.event.ended", filter: { ... } }` | runner | *Spec-undef:* filter shape. UX_JOURNEYS §26.2 lists `calendarIds, titleIncludesAny, minDurationMinutes, attendeeEmailIncludesAny` — for the spine, where do these live? In `trigger.filter`? In `shouldFire.params`? |
| 3 | System | (later) Calendar event ends at 14:30 | calendar connector emits `calendar.event.ended` | *Spec-undef:* who emits? GAP §3.5 says ActivitySignalBus carries this; W2-B migrates connectors. In Wave 1, calendar.event.ended is a known event kind but no contributor explicitly emits it. |
| 4 | System | Bus dispatches to runner | `ScheduledTaskRunner` event subscribe | |
| 5 | System | Runner finds matching tasks via `eventKind = "calendar.event.ended"` | indexed lookup | *Spec-undef:* index strategy. If 100 tasks listen to this event, full table scan? Filter evaluation in DB or in app? |
| 6 | System | Evaluates filter (e.g. `minDurationMinutes >= 15`) | filter evaluator | *Spec-undef:* schema for filter. JSON-with-Zod? Or hardcoded shape per event kind? |
| 7 | System | Fires task — runs prompt | LLM (1 L) | "Summarize the meeting that just ended at 14:30 (event id ABC)..." |
| 8 | System | Where does the prompt get the meeting context? | runtime context / connector read | *Spec-undef:* the prompt at fire-time has only `promptInstructions` (string). Does the runner inject the event payload into the prompt context? GAP §2.3 has no field for "context to inject". |
| 9 | System | Recap generated, dispatched via channel | | |
| 10 | User | Reads recap | | |
| 11 | System | Where does recap go? | *Spec-undef* | Apple Notes? Gmail? In-app card? The user's authoring utterance didn't specify. |

**What works in the proposed architecture:**
- Event-trigger via signal bus is the right primitive.
- Event-kind-as-namespaced-string (§8.2) avoids closed unions.

**Gaps / ambiguities found:**
1. **Filter schema is undefined.** Per-event-kind filters are stated but no schema mechanism (Zod registration tied to event-kind contribution?) is in the plan.
2. **Event payload → task context injection is undefined.** Without it, a recap task doesn't know which meeting just ended.
3. **Storage destination for the recap isn't part of `ScheduledTask`.** The user's authoring utterance has to specify; the planner has to extract; the spine doesn't have an "output destination" field.
4. **Concurrent fires.** Two meetings end simultaneously → two tasks fire concurrently → rate limit on Gmail? On LLM? No batch policy.
5. **Wave 1 has no contributor emitting `calendar.event.ended`.** Plan §3.4 says default packs include morning brief + habit starters but no calendar event detector. The detector lands in W2-B / W2-D. In Wave 1, this journey doesn't work.

**Latency budget:**
- ~1 S (event ingest) + 1 L (recap render) + 1 S (channel dispatch). User sees recap ~2–4 s after meeting ends.

**Failure modes:**
- Calendar connector reports event ended but actual meeting ran 5 min over. Recap generated based on calendar timestamp, not actual end. Off by 5 min.
- Multiple recipients on the meeting: the task fires for the user only, but the recap might reference attendees the user can't see (privacy filter not specified for event payloads).
- If the connector hasn't synced for 30 min, the event arrives 30 min late.

**Dependencies on undefined components:**
- Event-payload-to-task-context binding.
- Filter schema mechanism.
- Output-destination contract.

---

## Journey 8: Habit with completion via health signal (Apple Health)

**Source:** UX_JOURNEYS.md §16.1, §21.1; GAP §3.5 ActivitySignalBus, §2.3 `completionCheck.kind = "health_signal_observed"`.

**Pre-conditions:** `plugin-health` installed, Apple Health connected, user authored "remind me to brush teeth, mark complete via health if available".

**Step-by-step trace:**

| # | Actor | Action / Event | Architecture component | Notes |
|---|---|---|---|---|
| 1 | System | (08:00) brush task fires | runner | |
| 2 | System | Renders prompt | LLM (1 L) | |
| 3 | User | (Brushes teeth) | | iOS HealthKit logs `HKCategoryTypeIdentifierToothbrushingEvent`. |
| 4 | System | `plugin-health` ingests via HealthKit CLI helper or Apple Watch sync | `health-bridge.ts` | 1 S. |
| 5 | System | Publishes `health.toothbrushing.observed` on the bus | ActivitySignalBus | *Spec-undef:* the bus contribution surface (W2-D). In Wave 1, `plugin-health` publishes via `ActivitySignalBus` if the bus is ready, otherwise direct. |
| 6 | System | Runner subscribes; task's `completionCheck.kind === "health_signal_observed"` matches signal kind `health.toothbrushing` | `CompletionCheckRegistry` | *Spec-undef:* parameter shape — does `params: { signalKind: "toothbrushing" }` filter? The registry signature isn't specified. |
| 7 | System | State → `completed` | runner | |
| 8 | System | (Pipeline if any) | | |

**Alt path: Apple Health not connected.**

| 1 | System | task fires | | |
| 2-3 | (same) | | | |
| 4' | User | brushes (no signal) | | |
| 5' | System | Followup task fires after 30 min | pipeline.onSkip | |
| 6' | User | "I brushed already" | | |
| 7' | System | Planner → `complete_occurrence` | LLM (1 L) | Manual completion. |

**Alt path: multiple tasks watch the same signal.**

| 1 | System | Two tasks both have `completionCheck.kind = "health_signal_observed", params.signalKind = "toothbrushing"` | | E.g. AM brush + PM brush. |
| 2 | System | Signal arrives | | |
| 3 | System | Runner finds both matching | *Spec-undef* | Does it complete both? Only the most recent fired? Only the one within a recency window? Plan silent. |

**What works in the proposed architecture:**
- `health_signal_observed` is a registered completion-check kind from Wave 1.
- `plugin-health` extraction (W1-B) cleanly hosts the bridge.

**Gaps / ambiguities found:**
1. **CompletionCheck params schema isn't specified.** What does `params` look like for `health_signal_observed`? `{ signalKind, lookbackMinutes, requireSinceTaskFired }`?
2. **Multiple-tasks-one-signal disambiguation is undefined.**
3. **Signal-but-task-already-completed.** User brushes at 07:55 (before fire). Signal arrives at 08:00 just before the task fires. Does the task auto-complete pre-fire? Or fire anyway because the signal is "from before"?
4. **HealthKit availability.** On non-Mac systems the helper is gated by `process.platform === "darwin"`. Plan §4.3 acknowledges this. Linux/Windows users get nothing.
5. **Apple Health sync latency.** Signals can arrive minutes-to-hours late. The completion check window must be larger than that.

**Latency budget:**
- Active: 1 L + 0–N min wait for signal.

**Failure modes:**
- Lying: user says "I brushed" without a signal. The manual `complete_occurrence` path completes the task. Plan accepts this — no integrity check.
- Stale signal: HealthKit re-syncs yesterday's data; runner might match an old task. Need a "since task fired" filter that's not specified.
- Two devices: signal published twice (Apple Watch + iPhone). Idempotency on the bus?

**Dependencies on undefined components:**
- Completion-check params schema.
- Multi-task signal disambiguation.
- Cross-platform health availability.

---

## Journey 9: Stretch reminder with multi-gate

**Source:** UX_JOURNEYS.md §3.13, §7.11; HARDCODING_AUDIT §1, §5.3 ReminderGateRegistry; GAP §2.3 shouldFire.

**Pre-conditions:** stretch starter task in user's pack with multiple gates: `weekend_skip`, `late_evening_skip`, `walk_out_reset`.

**Step-by-step trace:**

| # | Actor | Action / Event | Architecture component | Notes |
|---|---|---|---|---|
| 1 | System | (Saturday 14:00) interval timer fires | runner | |
| 2 | System | Evaluates `shouldFire` gates | TaskGateRegistry | *Spec-undef:* `shouldFire` is a single field. Multi-gate composition isn't in the schema. GAP §2.3 has `shouldFire?: { kind: string; params?: unknown }` — singular. |
| 3 | System | Picks first gate? Composes? | *Spec-undef* | If three gates are needed (weekend_skip, late_evening_skip, walk_out_reset), the schema doesn't support `shouldFire` as an array. |
| 4 | System | Assume composition works | hypothetical | weekend_skip → DENY (Saturday). |
| 5 | System | Task is skipped | state → `skipped` | |
| 6 | User | sees nothing | | *Spec-undef:* per UX_JOURNEYS §7.12, `blocked_quiet_hours` is a reminder attempt outcome. Equivalent for "skipped because gate denied" — silent? Logged? Surfaced to user? |
| 7 | System | (Sunday 21:30) | | late_evening_skip evaluated → DENY. |
| 8 | System | (Monday 14:00) | | All gates allow → fires. |
| 9 | System | But user just walked > 5min (health signal) at 13:55 | walk_out_reset | This gate is supposed to RESET cooldown not skip the fire. Different gate semantics: "skip" vs "reschedule". |
| 10 | System | Schema gap | *Spec-undef* | GAP §2.3 says gates return `allow / deny / defer`. `defer` is a reschedule. But the data structure for "defer until when" isn't spec'd. |
| 11 | System | (Eventually) task fires | | LLM (1 L) renders. |
| 12 | User | Sees stretch reminder | | |

**What works in the proposed architecture:**
- Replacing `stretch-decider.ts` with registered gates is a cleaner shape.
- `defer` semantics in GAP §2.3 alludes to reschedule.

**Gaps / ambiguities found:**
1. **Multi-gate composition is missing from the schema.** Single `shouldFire` field can't represent N gates. Plan doesn't address.
2. **Gate-conflict resolution undefined.** If `weekend_skip = ALLOW` but `late_evening_skip = DENY`, what's the runner do? OR-logic? AND-logic?
3. **`defer` shape is opaque.** "Reschedule cooldown" needs both "delay duration" and "what state the task ends in" (reschedule? snoozed? deferred-reset?).
4. **No "why didn't this fire?" surface.** UX_JOURNEYS §7.12 has reminder-attempt outcomes. Plan doesn't lift these to ScheduledTask. State log (W1-A append-only) helps, but loopback dev only.
5. **No user-visible "skipped, here's why" feedback.** The user wants to know "why did the system NOT remind me to stretch yesterday?"

**Latency budget:**
- Sub-second per gate evaluation. No LLM in gate path.

**Failure modes:**
- Two gates contradict — runner falls through to "fire anyway" or "skip anyway", no logged decision.
- `walk_out_reset` requires reading recent activity-bus signals. If the bus isn't queryable synchronously, gate evaluation has to wait or fall back. Spec silent.
- Time-zone shift mid-day: `late_evening_skip` evaluates against local TZ — if user travels, the gate may misfire.

**Dependencies on undefined components:**
- Multi-gate schema.
- Defer-with-when semantics.
- "Why didn't this fire" user surface.

---

## Journey 10: Followup repair (Pat hasn't replied for 4 days)

**Source:** UX_JOURNEYS.md §11.2, §11.4–§11.6; GAP §3.4 IdentityGraph + §2.7 (followup is `ScheduledTask` with completion=user_replied).

**Pre-conditions:** identity graph has Pat with email + phone; relationship row has `metadata.followupThresholdDays = 14`; user previously sent Pat a message 18 days ago; no reply.

**Step-by-step trace:**

| # | Actor | Action / Event | Architecture component | Notes |
|---|---|---|---|---|
| 1 | System | (Background watcher) | *Spec-undef* | GAP §2.7 says "the follow-up generator becomes a default-pack contributor that watches a subject (person, thread, document) and creates `ScheduledTask` entries when threshold is exceeded." But it doesn't specify the watcher's runtime mechanism. Cron? Bus subscriber? |
| 2 | System | Watcher runs daily | hypothetical | Reads `relationships` table; computes days-since-contact; matches against `followupThresholdDays`. |
| 3 | System | Detects "Pat overdue" | | |
| 4 | System | Creates `ScheduledTask` | runner | `completionCheck.kind = "subject_updated", params: { subjectKind: "thread", id: <threadId> }` |
| 5 | System | Task fires immediately (or at next morning) | | *Spec-undef:* when does the followup-generator-task fire? The task itself is created with what trigger? Watcher creates a `trigger.kind = "manual"` task for now-or-next-window? |
| 6 | System | Renders prompt | LLM (1 L) | "Pat hasn't replied to your last message about X for 18 days — want me to draft a nudge?" |
| 7 | System | Surfaces to user | channel | *Spec-undef:* in-app card? Chat message? Daily brief section? UX_JOURNEYS §11.1 catalog mentions `INBOX_SUMMARIZE_CHANNEL` |
| 8 | User | "yes, draft it" | | |
| 9 | System | Routes to draft pipeline (Journey 6) | | |
| 10 | User | Approves & sends | | |
| 11 | System | Followup task — completion check is `subject_updated(thread, id)` | runner | *Spec-undef:* who emits `subject_updated`? The Gmail connector when Pat replies? The runner when the user sends an outbound? Both? Different semantics. |

**What works in the proposed architecture:**
- "Followup is a `ScheduledTask` with `completionCheck=user_replied/subject_updated`" is conceptually clean.
- Watcher → spawn task is a contributor pattern.

**Gaps / ambiguities found:**
1. **The watcher's runtime mechanism is unspecified.** GAP §2.7 mentions it; IMP doesn't list a watcher in any agent's owned files in Wave 1 or Wave 2. *spec-undef.*
2. **`subject_updated` event source.** Who emits it? Inbound message arrives → connector emits → runner matches subject. The connector→subject correlation isn't specified.
3. **Outbound nudge "completes" the followup or "resets the clock"?** If the user sends a nudge and Pat doesn't reply, does the followup re-create after another 14 days?
4. **Multi-thread Pat.** Pat replies on a different thread. Does that count as `subject_updated` for the followup linked to thread 1?
5. **Cross-channel reply.** User Gmail-sent; Pat replies via Telegram. Identity graph collapses Pat to one person — does the followup complete?
6. **First-run customize Q5 ("3–5 important relationships") creates followup tasks** but plan doesn't specify the exact `ScheduledTask` shape produced.

**Latency budget:**
- Watcher → 1 S background. User-perceived: 1 L on detection notification + draft pipeline (Journey 6) = 4+ L total.

**Failure modes:**
- Pat replied but the connector hadn't synced. Followup nudges Pat unnecessarily.
- Identity graph misclassified — followup tracks "Pat Smith" but Pat replies as "P. Smith" on a different platform; subject_updated never fires.
- Watcher runs at 02:00; user logs in at 09:00. Latency 7 hours for "I should have known about this overdue followup".

**Dependencies on undefined components:**
- Watcher runtime spec.
- subject_updated event emission.
- Cross-thread / cross-channel completion semantics.

---

## Journey 11: Travel booking with approval (compound)

**Source:** UX_JOURNEYS.md §10.2; GAP §7.1 (BOOK_TRAVEL stays compound), §3.3 ApprovalQueue.

**Pre-conditions:** Duffel connector configured; user has stored travel preferences; Cloud auth granted.

**Step-by-step trace:**

| # | Actor | Action / Event | Architecture component | Notes |
|---|---|---|---|---|
| 1 | User | "Book my LA trip next month" | planner | |
| 2 | System | Routes to `BOOK_TRAVEL` umbrella | LLM (1 L) | Compound, stays as one action per GAP §7.1. |
| 3 | System | Reads travel preferences | OwnerFactStore | 1 S. |
| 4 | System | Calls Duffel offer-request | ConnectorRegistry.duffel | 1 S. |
| 5 | System | Calls Duffel offer fetch | | 1 S. |
| 6 | System | Drafts trip card | LLM (1 L) | |
| 7 | System | Enqueues approval | ApprovalQueue.enqueue | *Spec-undef:* does this also create an approval `ScheduledTask`? GAP §3.3 says the queue IS the listing for approval-typed tasks — implies yes. But BOOK_TRAVEL is compound, not pipelined. Two parallel listings? |
| 8 | System | Returns "Queued travel approval for ..." | | User sees pending. |
| 9 | User | (Some time later) "approve that booking" | | |
| 10 | System | Routes to `RESOLVE_REQUEST.approve` | LLM (1 L) | *Spec-undef:* or to `SCHEDULED_TASK.complete` if approval is a task? Both routes plausible. |
| 11 | System | ApprovalResolverRegistry dispatches `book_travel` resolver | GAP §3.3 | |
| 12 | System | Calls Duffel `/air/orders` | connector | 1–3 S. |
| 13 | System | Calls Duffel `/air/payments` | connector | 1–3 S. |
| 14 | System | Posts calendar event (calendarSync) | google-calendar connector | 1 S. |
| 15 | System | Resolution reply | LLM (1 L) | "Booked! Confirmation #..." |

**What works in the proposed architecture:**
- BOOK_TRAVEL stays compound — clean transactional thread.
- Resolver registry decouples `RESOLVE_REQUEST.approve` from booking impl.

**Gaps / ambiguities found:**
1. **Approval queue ↔ ScheduledTask relationship.** Is a queued approval ALSO a `ScheduledTask` with `kind = "approval"`? Or are these separate concepts? Plan ambiguous.
2. **Reject path doesn't cascade cleanly.** If approval is rejected, the held Duffel offer expires after ~15 min. No `onReject` cleanup task is documented.
3. **Mid-flight error during payment.** Order placed, payment fails. Compound transactionality has no rollback documented.
4. **Calendar sync as a side step.** If calendar sync fails after booking, user sees "Booked!" but no calendar event.
5. **Travel feature flag (`travel.book_flight`) gate.** GAP §3.8 says feature flag — `travel.book_flight` is OFF unless cloud auth. Authorization path conflated with capability.

**Latency budget:**
- Initial drafting: 1 L + 3 S ≈ 5 s.
- Approval execution: 1 L + 3–5 S ≈ 5–8 s.
- Total user-perceived from "approve" to "booked": 5–8 s.

**Failure modes:**
- Duffel offer expired between draft and approve (held offers expire). Compound action must re-fetch or fail; not specified.
- Cloud auth lapsed — `travel.book_flight` flips OFF mid-flow. Approve attempt rejects with feature-disabled. User confused.
- Calendar conflict detected after booking but before sync. Spec says "auto-booking forbidden if conflict"; not clear if this fires post-approve.

**Dependencies on undefined components:**
- Approval queue ↔ ScheduledTask unification.
- Reject-side cleanup.
- Mid-flow failure rollback.

---

## Journey 12: Self-control / blocker with earn-back

**Source:** UX_JOURNEYS.md §3.15, §13.6; GAP §3.6 BlockerRegistry; IMP §5.6 W2-F.

**Pre-conditions:** workout `ScheduledTask` configured with website-blocker pipeline; first-run customize had blockers category.

**Step-by-step trace:**

| # | Actor | Action / Event | Architecture component | Notes |
|---|---|---|---|---|
| 1 | System | (Workout-window start, e.g. 14:00) | runner | |
| 2 | System | Pre-task: BLOCKER action sets blocks | *Spec-undef* | Where does the pre-task come from? GAP §2.4 habit-starters mentions workout pack with `websiteAccess` policy. The block applies *during* the window or *until* completion? |
| 3 | System | Block hosts file write | BlockerRegistry → hosts-file enforcer | 1 S. |
| 4 | System | Workout `ScheduledTask` fires | | LLM (1 L) renders prompt. |
| 5 | User | (Goes to gym, no signal) | | |
| 6 | User | (Comes back) "I worked out" | inbound | |
| 7 | System | `complete_occurrence` | LLM (1 L) | *Spec-undef:* completion-check kind for "user said they did it" without health signal — `user_acknowledged`? `user_replied`? `manual_complete`? |
| 8 | System | Pipeline `onComplete` → unblock task | runner | `trigger.kind = "after_task"`, `outcome = "completed"`. |
| 9 | System | Unblock task fires | | |
| 10 | System | BlockerRegistry releases | | hosts file restored. |
| 11 | System | Unlock duration starts | timer (`unlockDurationMinutes = 60`) | 1 S timer. |
| 12 | System | (60 min later) re-block | follow-up `ScheduledTask` with `trigger.kind = "after_task"` chained | |
| 13 | User | Tries youtube.com → blocked again | | |

**What works in the proposed architecture:**
- BlockerRegistry (W2-F) is the right shape.
- `trigger.kind = "after_task"` cleanly chains relock.
- `unlockMode: "fixed_duration"` from existing `LifeOpsWebsiteAccessPolicy` (UX_JOURNEYS §13.6) carries forward.

**Gaps / ambiguities found:**
1. **Lying-completion is unaddressed.** User says "I worked out", task completes, blocker releases — no integrity check. UX_JOURNEYS § doesn't require one but the user's instruction explicitly raises it. Plan silent.
2. **Block scoping.** Block applies during the workout window or until completion? Both? Pipeline has `onComplete` → unblock; what about `onSkip`?
3. **Block conflict with other tasks.** If user has a 14:00 workout + 14:30 stretch, stretch task was supposed to fire — but blocked sites issue irrelevant to it. Is there cross-pipeline cleanup?
4. **OS-level enforcement.** Hosts file requires elevation (UX_JOURNEYS §13.3). Spec doesn't say what happens if elevation isn't granted.
5. **Cross-device blocking.** User on phone — hosts-file block doesn't apply.

**Latency budget:**
- 2 L (fire + completion) + 3–4 S (block/unblock writes). Fast user-side.

**Failure modes:**
- Lying — system trusts.
- Hosts-file write fails silently → no block but task believes it's blocking.
- User completes via different channel (workout app's HealthKit signal) but the channel hadn't surfaced; the task is `expired`, signal arrives — no longer matches the open task.

**Dependencies on undefined components:**
- Integrity check for self-reported completions.
- Block-scope contract.
- Cross-task cleanup on conflict.

---

## Journey 13: Group chat handoff

**Source:** UX_JOURNEYS.md §14.1; GAP §3.4 IdentityGraph; partial existing implementation.

**Pre-conditions:** three-person thread; agent in mid-conversation.

**Step-by-step trace:**

| # | Actor | Action / Event | Architecture component | Notes |
|---|---|---|---|---|
| 1 | Agent | Engaged in 3-way thread | running | |
| 2 | Agent | Detects confusion / can't proceed | *Spec-undef* | The "I'm stuck" detector isn't part of the spine plan. Possibly a `ScheduledTask` with `completionCheck=human_takes_over`? |
| 3 | System | Handoff verb | *Spec-undef* | What's the verb? "I'll let you take it from here" message? Mute the agent's contributions? End its turn? |
| 4 | System | Agent stops responding | *Spec-undef* | Mechanism: planner gates on "has handoff happened in this room"? Channel-policy update? |
| 5 | Human (other party) | Replies | | |
| 6 | System | Resume detection | *Spec-undef* | When does agent re-engage? After N minutes silence? When user @mentions agent? |

**What works in the proposed architecture:**
- IdentityGraph (W2-D) gives the agent a picture of who's in the thread.

**Gaps / ambiguities found:**
1. **Handoff verb is entirely unspecified.** No action, no provider, no channel-policy update.
2. **Resume condition unspecified.**
3. **No state for "this thread is in handoff mode".** Where does it live?
4. **Mid-chat confusion detector is unspecified.**
5. **This journey is one of the existing UX_JOURNEYS rows but the architecture has no slot for it.** Major gap.

**Latency budget:** N/A — handoff happens.

**Failure modes:**
- Agent doesn't realize it's in a 3-way thread; replies to the other human as if it were the user.
- Resume fires too eagerly; agent jumps back in mid-human-conversation.
- Handoff state lost on agent restart.

**Dependencies on undefined components:**
- Handoff verb.
- Handoff state store.
- Resume condition.

---

## Journey 14: Multilingual habit (Spanish)

**Source:** UX_JOURNEYS.md §3.6, §27.1; GAP §3.7 MultilingualPromptRegistry; IMP §5.5 W2-E.

**Pre-conditions:** user's `OwnerFactStore.locale = "es"` (or detected on the fly).

**Step-by-step trace:**

| # | Actor | Action / Event | Architecture component | Notes |
|---|---|---|---|---|
| 1 | User | "recuérdame cepillarme los dientes a las 9pm" | planner | |
| 2 | System | Planner classifies | LLM (1 L) | *Spec-undef:* whether the planner's action examples are translated. In Wave 1, Spanish examples are inline (`life.ts:3509-3517`) — see HARDCODING_AUDIT §2 cat 5. After W2-E removes them and adds the registry, but registry isn't ready in Wave 1. Spanish customize-path may regress. |
| 3 | System | Extracts cadence | LLM (1 L) | |
| 4 | System | Creates `ScheduledTask` | runner | *Spec-undef:* `promptInstructions` in Spanish or English? GAP §8.4 says "ScheduledTask prompts are in the user's locale" — but the planner has been outputting English. Translation step? |
| 5 | System | (Next 9pm) task fires | runner | |
| 6 | System | Renders prompt | LLM (1 L) | Renders in Spanish if `promptInstructions` is Spanish. If English, renders English. |
| 7 | User | Sees "Time to brush!" or "¡Hora de cepillarte!" | depending on prompt language | |

**What works in the proposed architecture:**
- `MultilingualPromptRegistry` (GAP §3.7) is the right shape.
- Locale stored in OwnerFactStore (GAP §3.9).

**Gaps / ambiguities found:**
1. **Wave 1 has no multilingual support.** W2-E lands the registry; in Wave 1 Spanish examples are still inline.
2. **`promptInstructions` language is unspecified.** Spanish in, Spanish out? Translated to English internally for storage? Stored bilingually?
3. **Locale detection.** OwnerFactStore has locale; but if the user mixes languages, what wins?
4. **Action examples vs prompt content.** Planner uses examples (which become localized via registry); ScheduledTask prompts are user content. Two different layers.

**Latency budget:**
- Authoring: 2 L. Fire: 1 L. Same as English.

**Failure modes:**
- Planner classifies but output schema is in English; user gets mixed-language confirmation.
- Stored prompt in Spanish; user changes locale to French; prompt still fires in Spanish.

**Dependencies on undefined components:**
- prompt-language storage decision.
- Locale-mismatch handling.

---

## Journey 15: Plugin-health crossing — wake event drives a pipeline

**Source:** UX_JOURNEYS.md §4.5, §16.5; GAP §4 plugin-health; IMP §3.2 W1-B.

**Pre-conditions:** `plugin-health` installed; HealthKit + Apple Watch syncing; gn task scheduled at bedtime.target; gm task scheduled relative_to_anchor wake.confirmed.

**Step-by-step trace:**

| # | Actor | Action / Event | Architecture component | Notes |
|---|---|---|---|---|
| 1 | User | (Wakes up at 07:13) | | |
| 2 | System | Apple Watch detects wake | HealthKit | |
| 3 | System | `plugin-health` ingests | health-bridge | 1 S sync delay (~minutes). |
| 4 | System | Awake-probability rises past threshold | sleep-cycle.ts (in plugin-health) | |
| 5 | System | Publishes `health.wake.observed` | ActivitySignalBus | |
| 6 | System | Anchor `wake.observed` resolved at 07:13 | AnchorRegistry | |
| 7 | System | After confirmation logic, `wake.confirmed` fires (UX_JOURNEYS §16.5) | bus | |
| 8 | System | Runner subscribers: gm task with `trigger.kind = "relative_to_anchor", anchorKey = "wake.confirmed", offsetMinutes = 0` | runner | Fires. |
| 9 | System | gn task from yesterday — is it still open? | *Spec-undef* | If gn task was scheduled at 22:00 yesterday and never acknowledged, what's its state at 07:13 today? Default escalation ladder unspecified. |
| 10 | System | Sleep-recap task fires (default-pack) | another `ScheduledTask` listening to `wake.confirmed` | *Spec-undef:* multiple tasks fire on same event. Order? Priority? Sequential or parallel? |
| 11 | System | Morning-brief task fires (also listening) | | |
| 12 | User | Sees gm + sleep recap + morning brief? Three notifications? Or one merged? | *Spec-undef* | UX risk: spam at 07:13. |

**What works in the proposed architecture:**
- Anchor primitive is generalizable.
- `plugin-health` extraction (W1-B) cleanly hosts wake detection.

**Gaps / ambiguities found:**
1. **Yesterday's gn task at wake time is in limbo.** Spec doesn't define a "auto-close on next anchor" rule.
2. **Multi-task fire on same event.** Order of execution / batching unspecified. UX impact: spam.
3. **Wake-confirm vs wake-observe.** Two different anchors? UX_JOURNEYS §16.5 says yes (`wake.observed` then `wake.confirmed`). Plan §4.4 mentions `wake.confirmed` only. Drift.
4. **Latency: HealthKit sync lag means "wake detected at 07:13" might be "wake reported at 08:01". gm fires 48 min after the actual event.**
5. **Without plugin-health.** If user opts out, `wake.confirmed` never fires. Stub fallback (W1-A) uses `ownerFact.morningWindow.start` — but that's static.

**Latency budget:**
- HealthKit sync: 1–60 min after event.
- Bus → runner → fire: <1 s.
- Three concurrent tasks fire ≈ 3 L total.

**Failure modes:**
- Wake-confirm hysteresis: user briefly wakes at 04:00, falls back asleep, real wake at 07:13. Two `wake.confirmed` events? Once-only? Spec says nothing.
- Time-zone change overnight (e.g. red-eye): yesterday's gn anchor in old TZ; today's wake.confirmed in new TZ. Cron-scheduled tasks misfire.

**Dependencies on undefined components:**
- Stale-task cleanup on next anchor.
- Multi-task event-fire ordering.
- wake.observed vs wake.confirmed distinction.

---

## Journey 16: Snooze + escalate

**Source:** UX_JOURNEYS.md §5.2, §7.3, §7.9; GAP §2.3 escalation field.

**Pre-conditions:** task fires at 08:00 with escalation ladder `[in_app at 0min, push at 30min, sms at 60min]`.

**Step-by-step trace:**

| # | Actor | Action / Event | Architecture component | Notes |
|---|---|---|---|---|
| 1 | System | (08:00) fires via in_app | runner | |
| 2 | User | Taps "snooze 1h" | UI | `apply(taskId, "snooze", { minutes: 60 })` |
| 3 | System | Updates state, reschedules to 09:00 | runner | *Spec-undef:* does snooze reset escalation ladder, or continue from current step? |
| 4 | System | (09:00) fires | | |
| 5 | User | Snooze again 1h | | |
| 6 | System | (10:00) fires | | |
| 7 | System | Escalation kicks in — push channel | escalation evaluator | *Spec-undef:* escalation timer is from initial fire (08:00) or from last snooze (10:00)? GAP §2.3 has `escalation.steps` but no timing semantics. |
| 8 | System | Escalates to SMS | | *Spec-undef:* if SMS connector isn't configured, fall through? Skip? Fail? |
| 9 | User | Still ignores | | |
| 10 | System | "Give up" | *Spec-undef* | What state? `dismissed`? `expired`? `failed`? GAP §2.3 has both `dismissed` and `failed` — unclear which corresponds to "user ran out the ladder". |

**What works in the proposed architecture:**
- Snooze is a verb on the runner; same as `complete`/`skip`.
- Escalation steps are data on the task.

**Gaps / ambiguities found:**
1. **Snooze + escalation interaction undefined.** Three plausible policies; spec picks none.
2. **Connector unavailable mid-ladder.** Skip-and-continue? Dead-letter? Surface to user?
3. **Terminal state for "ran out of ladder".** Plan uses three different terminal states; not assigned.
4. **No "give up" trigger.** Each escalation step has a delay, but the *final* "ladder exhausted" state isn't an explicit step.
5. **Snooze infinitely.** Plan doesn't cap snooze attempts.

**Latency budget:**
- Sub-second per step + each escalation step's delay.

**Failure modes:**
- User snoozes 5 times → ladder restarts each time → SMS never fires.
- SMS dispatcher error → escalation believes it succeeded.

**Dependencies on undefined components:**
- Snooze-vs-escalation policy.
- Terminal-state assignment.
- Connector-fall-through behavior.

---

## Journey 17: Connector outage during a fire

**Source:** UX_JOURNEYS.md §20.16 connector degradation, §7.12 attempt outcomes; GAP §3.1 ConnectorRegistry.

**Pre-conditions:** task wants to send via Telegram; Telegram dispatcher status is `disconnected` (e.g. session revoked).

**Step-by-step trace:**

| # | Actor | Action / Event | Architecture component | Notes |
|---|---|---|---|---|
| 1 | System | Task fires | runner | |
| 2 | System | Renders | LLM (1 L) | |
| 3 | System | Channel dispatch — `telegram.send` | ConnectorRegistry → Telegram dispatcher | |
| 4 | System | Telegram returns `disconnected` | | |
| 5 | System | What now? | *Spec-undef* | Options: (a) skip silently, (b) fall back to next channel in escalation, (c) fail and mark task `failed`, (d) queue for re-try when connector returns. Plan §3.1 says "ConnectorContribution" but says nothing about transport-failure protocol. |
| 6 | System | Surface to user | *Spec-undef* | Existing reminder-attempt outcomes (UX_JOURNEYS §7.12) include `blocked_connector`. New spine doesn't lift these. |
| 7 | User | Sees… nothing? | | |

**What works:**
- ConnectorRegistry status field exists.

**Gaps / ambiguities found:**
1. **Transport-failure protocol unspecified.**
2. **Fallback ordering.** If escalation has multiple channels, does dispatch automatically advance on connector failure?
3. **No queue for retry.** Connector recovers — task already terminated? Or re-fires?
4. **Reminder-attempt-outcomes not lifted.** Existing useful taxonomy lost.
5. **No user-visible "we couldn't reach you" surface.**

**Latency budget:**
- Dispatch attempt + timeout + fallback: 5–30 s.

**Failure modes:**
- Silent failure — no surface to user, no audit log, no retry.
- Repeated failures over days, no aggregation.

**Dependencies on undefined components:**
- Transport-failure protocol.
- Retry queue.
- User surface for delivery failure.

---

## Journey 18: Re-running first-run after completion

**Source:** UX_JOURNEYS.md §1.7 "Re-run setup / disable LifeOps"; GAP §5; IMP §3.3 verification.

**Pre-conditions:** first-run completed 30 days ago; user has 12 customizations; user invokes "run setup again" via Settings or chat.

**Step-by-step trace:**

| # | Actor | Action / Event | Architecture component | Notes |
|---|---|---|---|---|
| 1 | User | "Run first-run again" | planner | |
| 2 | System | Action picked | LLM (1 L) | |
| 3 | System | Detects completed state | first-run/state.ts | |
| 4 | System | What does it do? | *Spec-undef* | IMP §3.3 verification step says "re-invocation is a no-op (or surfaces 'already completed')" — already two options without picking. |
| 5 | System | Plausible path A: error / no-op. | | UX bad. |
| 6 | System | Plausible path B: offer to merge. | | Where do new answers go? Overwrite OwnerFactStore? Append? |
| 7 | System | Plausible path C: wipe-and-restart. | | What happens to user's existing 12 customizations? |
| 8 | System | (Picks one) | | |

**What works:**
- Re-entry is acknowledged as a UX concern (IMP §3.3).

**Gaps / ambiguities found:**
1. **Re-run semantics is genuinely undefined.** Plan offers ≥3 paths.
2. **Merge protocol absent.** If "yes please re-customize", how do user's authored tasks survive?
3. **`Disable LifeOps` (UX_JOURNEYS §1.7) — analogous question: do tasks pause or delete?** Plan doesn't address.
4. **Settings UI has "Run setup again" button — what API does it call?** Plan doesn't list endpoint.
5. **Partial re-run.** "Just update my time zone" — should re-run support single-question editing? Or is that a separate `OwnerFactStore.update` action?

**Latency budget:** N/A — flow not defined.

**Failure modes:**
- Wipe-and-restart silently nukes user's 12 customizations.
- Merge silently keeps stale anchor data; new anchor data writes ignored.
- "Disable" silently turns off but tasks keep firing if scheduler doesn't read disabled state.

**Dependencies on undefined components:**
- Re-run resolution.
- Disable semantics.
- Partial-edit path.

---

# Cross-Journey Findings

Findings are grouped by theme (not by journey). Each carries affected-journey tags, severity, and a concrete plan-section recommendation.

## 1. Persistence gaps

### 1.1 Draft body persistence
**Tags:** J6.
**Severity:** High.
**Recommendation:** GAP §2.3 — add an explicit `taskOutput?` field on `ScheduledTask` for "data the task produced" (draft body, recap text), or specify an external `lifeops_outputs` table the spine references. Pick one and document.

### 1.2 First-run state machine
**Tags:** J2, J18.
**Severity:** High.
**Recommendation:** IMP §3.3 — define abandon/resume + re-run merge behavior. Concretely: a `first_run_state` row with `{ status: not_started | in_progress | completed | re_running, partialAnswers, completedAt }` and explicit transitions.

### 1.3 Approval queue ↔ ScheduledTask unification
**Tags:** J6, J11.
**Severity:** High.
**Recommendation:** GAP §3.3 — explicitly state whether queued approvals are also ScheduledTask rows (with `kind = "approval"`) or a separate type. If unified, document the read API (one endpoint, both views). If separate, document why.

### 1.4 ScheduledTask state log retention
**Tags:** J4, J9, J16.
**Severity:** Medium.
**Recommendation:** IMP §8.8 — pick a number (90 days?) and ship a rollup pass. Otherwise the table grows unboundedly and observability becomes opaque.

### 1.5 Watcher-task association
**Tags:** J10.
**Severity:** High.
**Recommendation:** GAP §2.7 / new section — define the watcher runtime: cron task vs bus subscriber, and which agent owns it in IMP §3 / §5.

## 2. Schema gaps in `ScheduledTask`

### 2.1 Multi-gate composition (`shouldFire` array)
**Tags:** J9.
**Severity:** High.
**Recommendation:** GAP §2.3 — change `shouldFire?: { kind, params }` to `shouldFire?: Array<{ kind, params }>` plus a composition mode (`all | any | first_deny`).

### 2.2 Output destination
**Tags:** J7, J3.
**Severity:** High.
**Recommendation:** GAP §2.3 — add `output?: { destination: ChannelKind, target?: string }` so the recap-task knows where the recap goes.

### 2.3 Event-payload context injection
**Tags:** J7, J15.
**Severity:** High.
**Recommendation:** GAP §2.3 — define how the runner injects the triggering event's payload into the task's prompt context (e.g. `promptInstructions: string + contextSchema: ZodSchema`).

### 2.4 Filter schema for `trigger.kind = "event"`
**Tags:** J7.
**Severity:** Medium.
**Recommendation:** GAP §2.3 — `filter?: unknown` → typed per event-kind via the EventKindRegistry.

### 2.5 Defer (gate decision) shape
**Tags:** J9.
**Severity:** Medium.
**Recommendation:** GAP §2.3 — gate decision union: `{ kind: "allow" } | { kind: "deny" } | { kind: "defer", until: IsoDateString | { offsetMinutes: number } }`.

### 2.6 Task `kind` field
**Tags:** J11.
**Severity:** Medium.
**Recommendation:** ScheduledTask should declare its kind (`reminder | followup | approval | recap | watcher | output`) so consumers (UI, listings) can group.

### 2.7 Idempotency key
**Tags:** J3 (retry-after-cancel), J8 (signal-twice).
**Severity:** Medium.
**Recommendation:** GAP §2.3 — `idempotencyKey?: string` so duplicate creates collapse.

## 3. Action-surface gaps (plan doesn't enumerate; journeys need)

### 3.1 Group-chat handoff verb
**Tags:** J13.
**Severity:** Critical.
**Recommendation:** GAP §3 / IMP §5 — add `MESSAGE.handoff` verb plus a `room_handoff_state` store. Currently no plan section covers J13.

### 3.2 First-run abandon / partial-edit verbs
**Tags:** J2, J18.
**Severity:** High.
**Recommendation:** IMP §3.3 — `FIRST_RUN.abandon`, `FIRST_RUN.update_field`, `FIRST_RUN.replay`.

### 3.3 ScheduledTask edit verb
**Tags:** J3, J6.
**Severity:** High.
**Recommendation:** GAP §2.3 / IMP §3.1 — `apply(taskId, "edit", patch)` is missing from the verb list (`schedule | list | apply (snooze/skip/complete) | pipeline`).

### 3.4 Disable / pause LifeOps
**Tags:** J18.
**Severity:** Medium.
**Recommendation:** Settings → "Disable LifeOps" maps to what? Add `LIFEOPS.pause / resume / wipe`.

### 3.5 "Why didn't this fire?" explainer
**Tags:** J9, J17, J16.
**Severity:** Medium.
**Recommendation:** Provider or REST endpoint surfacing recent gate decisions / dispatch failures user-side, not just dev-side (`GET /api/lifeops/dev/scheduled-tasks/:id/log` is loopback per GAP §8.6).

## 4. Provider-surface gaps

### 4.1 First-run affordance schema
**Tags:** J1, J2.
**Severity:** High.
**Recommendation:** IMP §3.3 — define exact provider-output contract for "first-run not yet completed". Without it, planner integration tests are non-deterministic.

### 4.2 "User has been quiet N days" provider
**Tags:** J5.
**Severity:** High.
**Recommendation:** New provider summarizing recent ScheduledTask state. Not in any plan section.

### 4.3 Open-prompts provider (inbound-to-task correlation)
**Tags:** J5.
**Severity:** Critical.
**Recommendation:** New provider that surfaces "this room currently has an open prompt waiting for reply" so the planner can route inbound messages to a task's `completionCheck`. Without this, `user_replied_within` doesn't resolve.

### 4.4 Pending approvals provider
**Tags:** J6, J11.
**Severity:** Medium.
**Recommendation:** GAP §3.3 — provider that lists outstanding approvals so daily brief / morning-brief assembler can surface them.

## 5. Connector / channel contract gaps

### 5.1 Transport-failure protocol
**Tags:** J17.
**Severity:** Critical.
**Recommendation:** GAP §3.1 / §3.2 — `ConnectorContribution.send` returns a typed result `{ ok: true } | { ok: false, reason: "disconnected" | "rate_limited" | "auth_expired" | ..., retryAfter? }`. Channel dispatch policy: on failure, advance escalation OR queue for retry OR fail-cascade.

### 5.2 Channel-fall-through escalation policy
**Tags:** J4, J16, J17.
**Severity:** High.
**Recommendation:** GAP §3.2 — explicit semantics for "channel X down → use Y from the ladder".

### 5.3 Cross-device acknowledgement
**Tags:** J4 (gm on multi-device), UX_JOURNEYS §7.8.
**Severity:** High.
**Recommendation:** GAP §3.2 — channel contract must describe device-fan-out + ack-sync.

### 5.4 Channel availability validation at customize time
**Tags:** J2 (Q4).
**Severity:** Medium.
**Recommendation:** First-run customize should validate channel-is-connected before storing the preference.

### 5.5 Connector-disabled feature-flag interplay
**Tags:** J11.
**Severity:** Medium.
**Recommendation:** GAP §3.1 + §3.8 — explicitly link feature flag → connector → action enable.

## 6. Observability gaps

### 6.1 User-visible "why did/didn't this fire?"
**Tags:** J9, J16, J17.
**Severity:** High.
**Recommendation:** GAP §8.6 — lift the dev-only state log to a user-visible "history" surface for each task.

### 6.2 Pipeline-position observability
**Tags:** J6, J12.
**Severity:** Medium.
**Recommendation:** "Where is this in its pipeline?" — add `pipelineParentId` to children + a UI surface.

### 6.3 Aggregate "missed last 3 check-ins"
**Tags:** J5.
**Severity:** High.
**Recommendation:** Pair §4.2 above; this is the user's specific concern.

### 6.4 Connector-status drift surface
**Tags:** J17.
**Severity:** Medium.
**Recommendation:** Per UX_JOURNEYS §20.16 `LifeOpsConnectorDegradation` — wire it back into the daily brief.

## 7. Latency / round-trip concerns

### 7.1 First-run customize 6+ LLM round-trips
**Tags:** J2.
**Severity:** Medium.
**Recommendation:** Either combine questions into one larger prompt (1 L instead of 5–7) or accept the latency budget and document realistic 2–4 minute completion time. GAP §5.3's "90 seconds" is implausible.

### 7.2 Pipelined task chains can multiply LLM calls
**Tags:** J6, J15.
**Severity:** Medium.
**Recommendation:** GAP §9.1 acknowledges this. The proposed mitigation (batch sibling tasks into one LLM context) only works for siblings, not chains. A 5-deep pipeline = 5 L + 5 S minimum.

### 7.3 Concurrent fires on same anchor
**Tags:** J15.
**Severity:** Medium.
**Recommendation:** Define ordering and merging policy. e.g. "all `wake.confirmed` tasks fire concurrently but are batched into a single user-facing message".

## 8. State-machine completeness

### 8.1 Terminal-state taxonomy
**Tags:** J4, J5, J16.
**Severity:** High.
**Recommendation:** GAP §2.3 — pin which terminal state corresponds to which scenario:
- `dismissed` = user explicitly dismissed.
- `expired` = no response, ladder exhausted.
- `failed` = system error / connector outage.
- `skipped` = gate denied or user said skip.

### 8.2 `acknowledged` vs `completed`
**Tags:** J4.
**Severity:** Medium.
**Recommendation:** GAP §2.3 — define which triggers `pipeline.onComplete`. Most likely `completed`, with `acknowledged` being non-terminal.

### 8.3 Snooze + escalation interaction
**Tags:** J16.
**Severity:** High.
**Recommendation:** GAP §2.3 — pick: snooze resets ladder, snooze freezes ladder, or snooze advances ladder by elapsed time.

### 8.4 Re-fire after terminal state
**Tags:** J5, J11, J17.
**Severity:** Medium.
**Recommendation:** Once a task is `expired`, can a late inbound message re-open it? GAP doesn't say.

### 8.5 Cross-day stale tasks
**Tags:** J15.
**Severity:** Medium.
**Recommendation:** Auto-close-on-next-anchor rule.

## 9. First-run-flow gaps

### 9.1 Path-selection contract
**Tags:** J1, J2.
**Severity:** High.
**Recommendation:** IMP §3.3 — pick (a) action prompts inline, (b) planner pre-selects, or (c) defaults-as-default.

### 9.2 Default morning window is hostile
**Tags:** J1.
**Severity:** High.
**Recommendation:** Even Path A should ask one question (wake time) before scheduling gm.

### 9.3 Re-run resolution
**Tags:** J18.
**Severity:** High.
**Recommendation:** Pick wipe-vs-merge.

### 9.4 Customize Q4 channel-validation
**Tags:** J2.
**Severity:** Medium.
**Recommendation:** Validate before storing.

### 9.5 "First task fires tomorrow" is too far
**Tags:** J1.
**Severity:** Low.
**Recommendation:** Consider a "test-fire one task now" option to demonstrate the agent is alive.

## 10. plugin-health boundary issues

### 10.1 `wake.observed` vs `wake.confirmed` distinction
**Tags:** J15.
**Severity:** Medium.
**Recommendation:** GAP §4.4 — register both as separate anchors with documented semantics (observe = first signal; confirm = sustained signal).

### 10.2 Health connector unavailable fallback
**Tags:** J8, J15.
**Severity:** High.
**Recommendation:** IMP §3.1 stub anchors document a fallback for `wake.confirmed`. The plan should also document fallbacks for `health_signal_observed` completion checks (e.g. graceful degradation to `user_acknowledged`).

### 10.3 Cross-platform health
**Tags:** J8, J15.
**Severity:** Medium.
**Recommendation:** GAP §4 — document explicit "darwin-only" caveats and what non-mac users see.

### 10.4 Multi-task / one-signal disambiguation
**Tags:** J8, J15.
**Severity:** High.
**Recommendation:** GAP §3.5 / §4 — completion-check params must include `lookbackMinutes` and `requireSinceTaskFired` to scope signal-to-task matching.

### 10.5 Bus contribution surface deadline
**Tags:** J7, J8, J15.
**Severity:** Medium.
**Recommendation:** IMP §3.2 says "if the bus contribution surface isn't ready in time, keep the union open in Wave 1" — make sure Wave 1 ships either the contribution surface OR a clear stub that doesn't break consumers.

---

# Top 10 Most Important Findings

Ranked by user-impact + architectural-load-bearing-ness.

1. **Inbound-message-to-task correlation is undefined.** *Affected:* J5 (the user's own concern), J6, J10. *Fix:* GAP §2.3 + a new "open-prompts" provider that lets the planner correlate an inbound message with the open ScheduledTask it's replying to. Without this, `completionCheck.kind = "user_replied_within"` literally cannot resolve.

2. **Group-chat handoff has zero architecture.** *Affected:* J13. *Fix:* Add `MESSAGE.handoff` verb + `room_handoff_state` store + resume-condition spec. Major journey with no plan slot.

3. **Multi-gate composition isn't in the schema.** *Affected:* J9. *Fix:* GAP §2.3 — change `shouldFire` from a single object to an array with a composition mode. Stretch alone needs 3 gates.

4. **Terminal-state taxonomy isn't pinned.** *Affected:* J4, J5, J16, J17. *Fix:* GAP §2.3 — explicitly assign `dismissed | expired | failed | skipped` to the four scenarios that produce them. Today the plan uses these interchangeably.

5. **"Did the user check in?" multi-day aggregation has no surface.** *Affected:* J5 (user's specific concern). *Fix:* Add a `recent_task_states` provider + a default-pack aggregator-task that surfaces "you've missed 3 check-ins in a row" the next morning.

6. **Approval queue ↔ ScheduledTask relationship is ambiguous.** *Affected:* J6, J11. *Fix:* GAP §3.3 — explicit unification (queued approvals ARE ScheduledTask rows with `kind = "approval"`) OR explicit separation with documented rationale. Currently both interpretations are supported by the text.

7. **Transport-failure protocol is undefined.** *Affected:* J4, J16, J17. *Fix:* GAP §3.1 / §3.2 — standardize `send` return shape and dispatch fallback policy. Without it, every connector outage produces a silent failure that the user discovers hours later.

8. **First-run defaults schedule a 06:00 gm reminder.** *Affected:* J1. *Fix:* Add a one-question wake-time prompt to Path A, or make the default human-friendly (e.g. ask + 8am as fallback).

9. **First-run re-run / disable semantics is genuinely undefined.** *Affected:* J18, every long-tenured user. *Fix:* IMP §3.3 — pin re-run = "merge new answers, keep customizations" + disable = "pause ScheduledTasks, don't delete".

10. **The watcher runtime that creates followup tasks is unspecified.** *Affected:* J10. *Fix:* GAP §2.7 + IMP §3 / §5 — pick a Wave-2 agent to own a `followup-watcher` cron-or-bus subscriber. The architecture treats it as if it materialized from the spine, but no agent's owned-files list mentions it.

---

*End of journey game-through. 18 journeys traced, ~80 distinct findings across 10 themes; 10 ranked top findings above. The architecture is fundamentally sound (the `ScheduledTask` spine is the right primitive); the gaps are concentrated in (a) state-machine completeness, (b) provider surface for correlation/observability, (c) channel/connector dispatch policy, and (d) first-run ergonomics.*
