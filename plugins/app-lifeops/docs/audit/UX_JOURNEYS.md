# LifeOps — Full User Experience Journey Reference

LifeOps is the elizaOS surface for tasks, habits, routines, reminders, and goals. Out of the box it lets a single owner manage one-off tasks, recurring habits, and longer-running routines through chat in any of the connected DM channels (Telegram, Discord, iMessage, Signal, WhatsApp, X DMs, SMS, in-app), through the dashboard UI at `/apps/lifeops`, and through the REST API at `/api/lifeops/*`. On top of that, LifeOps absorbs an "executive assistant" surface that triages email and chat inboxes, drives the calendar, manages a relationships rolodex with follow-ups, books and rebooks travel, signs and uploads documents, schedules reminder ladders across devices and channels, runs self-control flows that block apps and websites, captures device/screen activity to model sleep and presence, and brokers approvals for any side-effecting action.

> Source-citation tag legend (used inline on every flow). Where a flow has multiple supporting sources they are all listed.
>
> - `[scenarios/<id>.json]` — `eliza/plugins/app-lifeops/scenarios/*.json`
> - `[test/<file>]` — `eliza/plugins/app-lifeops/test/*.test.ts`
> - `[scenario-ts/<file>]` — `eliza/plugins/app-lifeops/test/scenarios/*.scenario.ts`
> - `[catalog/<id>]` — `eliza/plugins/app-lifeops/test/scenarios/_catalogs/*.json`
> - `[runtime-scenarios/<dir>/<file>]` — `eliza/test/scenarios/<dir>/*.scenario.ts`
> - `[mock/<id>]` — `eliza/test/mocks/environments/*.json`
> - `[docs/<path> §<section>]` — `eliza/packages/docs/**`
> - `[launchdocs/<n>]` — `eliza/packages/docs/docs/launchdocs/<n>-*.md`
> - `[contracts/<symbol>]` — `eliza/packages/shared/src/contracts/lifeops*.ts`
> - `[coverage-matrix #N]` — `eliza/plugins/app-lifeops/coverage-matrix.md` row N
> - `[settings-ux §<section>]` — `eliza/plugins/app-lifeops/docs/settings-access-ux.md`
> - `[checkin-todo]` — `eliza/plugins/app-lifeops/src/actions/CHECKIN_MIGRATION.TODO.md`

## Table of Contents

1. [Onboarding & first-run setup](#1-onboarding--first-run-setup)
2. [Core data model & overview surface](#2-core-data-model--overview-surface)
3. [Habits](#3-habits)
4. [Routines & multi-step daily flows](#4-routines--multi-step-daily-flows)
5. [Tasks (one-off)](#5-tasks-one-off)
6. [Goals](#6-goals)
7. [Reminders & escalation ladder](#7-reminders--escalation-ladder)
8. [Calendar journeys](#8-calendar-journeys)
9. [Inbox & email triage](#9-inbox--email-triage)
10. [Travel](#10-travel)
11. [Follow-up repair (relationships)](#11-follow-up-repair-relationships)
12. [Documents, signatures, portals](#12-documents-signatures-portals)
13. [Self-control / app & website blockers](#13-self-control--app--website-blockers)
14. [Group chat handoff](#14-group-chat-handoff)
15. [Multi-channel & cross-channel search](#15-multi-channel--cross-channel-search)
16. [Activity signals & screen context](#16-activity-signals--screen-context)
17. [Approval queues & action gating](#17-approval-queues--action-gating)
18. [Identity merge (canonical person)](#18-identity-merge-canonical-person)
19. [Memory recall](#19-memory-recall)
20. [Connectors & permissions](#20-connectors--permissions)
21. [Health, money, screen time](#21-health-money-screen-time)
22. [Push notifications](#22-push-notifications)
23. [Remote sessions](#23-remote-sessions)
24. [Settings & UX](#24-settings--ux)
25. [REST API access flows](#25-rest-api-access-flows)
26. [Workflows (event-triggered)](#26-workflows-event-triggered)
27. [Multilingual coverage](#27-multilingual-coverage)
28. [Suspected-but-unconfirmed flows](#28-suspected-but-unconfirmed-flows)

---

## 1. Onboarding & first-run setup

### 1.1 Open LifeOps for the first time

- **Actor / trigger:** User opens the LifeOps app from the dashboard, the OS Apps menu, or via deep link `/apps/lifeops`.
- **Preconditions:** Eliza desktop/web/mobile app installed and updated; LifeOps app enabled (it is a default-visible "featured" app `[launchdocs/16]`).
- **User actions and system responses:**
  1. User clicks the LifeOps tile in Apps (or follows a deep link).
  2. The LifeOps view opens. Boot config injects the LifeOps page component into app-core; mobile/desktop deep-link routing recognizes lifeops as a known target `[launchdocs/16]`.
  3. If LifeOps is not visible at all, the doc says "Update Eliza" `[docs/user/lifeops-setup.mdx §Open LifeOps]`.
- **Outcomes / success state:** LifeOps Access page renders showing source-health rows.
- **Variants:** On Electrobun the app menu has a dedicated LifeOps entry; mobile uses bottom-nav; web routes via the Apps catalog.

### 1.2 Create the first item (task / habit / routine)

- **Trigger:** User is in LifeOps with nothing configured.
- **Steps:**
  1. The setup doc instructs: pick `task` for one-off, `habit` for recurring, or `routine` for a recurring pattern.
  2. Example utterances: `Take meds at 8am`, `Inbox zero before lunch`, `Stretch for 10 minutes every evening` `[docs/user/lifeops-setup.mdx §Start with one item]`.
  3. For each item set: title, schedule, priority, reminders `[docs/user/lifeops-setup.mdx §Configure the basics]`.
- **Outcome:** A definition row exists in `/api/lifeops/definitions` with cadence + reminderPlan.

### 1.3 Add a goal that groups items

- **Trigger:** User wants to bind several items to a higher outcome.
- **Steps:** User states a goal title (`Sleep better`, `Ship the launch`, `Stay on top of email`); agent grounds the goal (see §6.1) and links definitions to the goal.
- **Outcome:** Goal exists with `status=active`, optionally `successCriteria`, and linked definitions surface in the goal review.

### 1.4 Connect Google (optional)

- **Trigger:** User wants calendar awareness, Gmail triage, or schedule-aware reminders.
- **Steps:**
  1. From the Access page open the User Google or Agent Google row.
  2. Pick mode: `cloud-managed` (Eliza Cloud), `local` (loopback OAuth), or `remote` (OAuth on a paired device) `[contracts/LifeOpsConnectorMode]`.
  3. Click `Connect`. The agent issues an `authUrl` through `/api/lifeops/connectors/google/start` and the popup begins OAuth. Redirect URI is included in the response `[contracts/StartLifeOpsGoogleConnectorResponse]`.
  4. Callback HTML posts back to the parent window; the hook refreshes the connector status.
  5. Agent-side Gmail grants are explicitly rejected with a message pointing at the dedicated Gmail plugin `[launchdocs/14 §Service-mixin-google]`.
- **Outcome:** Connector reason flips to `connected`, `grantedCapabilities` includes the requested set (`google.calendar.read`, `google.gmail.triage`, etc.), `LifeOpsGoogleConnectorStatus` reflects the new identity.
- **Variants:** "Add another account" — `createNewGrant=true` makes a parallel grant; "reauth" — pass `grantId` to refresh scopes.

### 1.5 Pair messaging connectors

- **Signal pairing:** Click `Connect` on Signal row → POST `/api/lifeops/connectors/signal/pair` returns `sessionId` → poll `/api/lifeops/connectors/signal/pairing-status?sessionId=<id>` until `state=waiting_for_scan` and `qrDataUrl` is non-null → user scans QR with the Signal phone app → state transitions to `linking` then `connected` → `/api/lifeops/connectors/signal/status` returns `reason=connected` and the linked phone number `[test/lifeops-signal.real.e2e.test.ts]`. User can `POST /stop` to abandon the pairing or `POST /disconnect` to drop the grant.
- **Telegram login:** User clicks `Connect` (no input visible until then `[settings-ux §Telegram]`) → enters phone number → `POST /api/lifeops/connectors/telegram/start` with `{phone}` → server returns `state=waiting_for_code` → user enters SMS code → `state=waiting_for_password` if 2FA → user enters password → `state=connected` `[contracts/LifeOpsTelegramAuthState]`.
- **Discord:** Discord linking is browser-driven. Status shows whether the DM inbox is visible inside the user's Discord tab; the next-action enum walks `connect_browser → open_extension_popup → enable_browser_access → enable_browser_control → open_discord → log_in → open_dm_inbox → focus_discord_manually` `[contracts/LIFEOPS_OWNER_BROWSER_NEXT_ACTIONS]`.
- **WhatsApp:** Hosted WhatsApp Business Cloud API (`cloudapi`) shows webhook-driven inbound and `outboundReady`; local Baileys mode shows QR pairing. Pairing uses generic app-core WhatsApp routes with `authScope: "lifeops"` `[launchdocs/14 §P2]`.
- **iMessage:** Local-only via BlueBubbles or `imsg`; Access shows degraded send-path and Full Disk Access controls when relevant `[settings-ux §iMessage]`.
- **X (Twitter):** `Connect`/`Reconnect` buttons drive owner-side and agent-side X OAuth. The previous post-composer UI was deleted from the primary surface `[settings-ux §X]`.

### 1.6 Connect health (Strava / Fitbit / Withings / Oura)

- **Trigger:** User wants sleep, readiness, or workout signals.
- **Steps:** `POST /api/lifeops/connectors/health/start` with `{provider, side, mode, capabilities}` → user completes OAuth → status polled at `/api/lifeops/connectors/health/status`. `lastSyncAt` and `expiresAt` reflect token state `[contracts/LifeOpsHealthConnectorStatus]`.
- **Outcome:** Health summaries expose `LifeOpsHealthDailySummary` rows with steps, sleep hours, HRV, etc.

### 1.7 Re-run setup / disable LifeOps

- **Trigger:** User clicks `Run setup again` or `Disable LifeOps` from Access header.
- **Outcome:** First reopens the onboarding gate; second turns off the LifeOps app integration entirely `[settings-ux §Access Header]`.

---

## 2. Core data model & overview surface

### 2.1 Definition kinds and statuses

| Field | Allowed values | Source |
|------|----------------|--------|
| `kind` | `task`, `habit`, `routine` | `[contracts/LIFEOPS_DEFINITION_KINDS]` |
| `status` | `active`, `paused`, `archived` | `[contracts/LIFEOPS_DEFINITION_STATUSES]` |

### 2.2 Occurrence states (single most-quoted enum)

| State | Meaning |
|------|---------|
| `pending` | Generated but not yet relevance-window |
| `visible` | In the active relevance window — surfaced to user |
| `snoozed` | Pushed forward by user action |
| `completed` | Marked done |
| `skipped` | User opted out of this instance |
| `expired` | Relevance window closed without action |
| `muted` | Suppressed by mute policy |

`[contracts/LIFEOPS_OCCURRENCE_STATES]`

### 2.3 Cadence types

- `once` — one-off due time `[contracts/LifeOpsCadence]`
- `daily` — repeats every day in named time-window(s)
- `times_per_day` — repeats at specific minute-of-day slots
- `interval` — every N minutes inside named windows, capped per day
- `weekly` — specific weekdays inside named time-window(s)

### 2.4 Time windows

Built-in window names: `morning`, `afternoon`, `evening`, `night`, `custom`. Each has start/end minute-of-day in user TZ `[docs/rest/lifeops.md §Time windows]`.

### 2.5 Goal statuses & review states

- Status: `active`, `paused`, `archived`, `satisfied` `[contracts/LIFEOPS_GOAL_STATUSES]`
- Review state: `idle`, `needs_attention`, `on_track`, `at_risk` `[contracts/LIFEOPS_REVIEW_STATES]`

### 2.6 Get the LifeOps overview

- **Flow:** `GET /api/lifeops/overview` → returns occurrences (with denormalized definition title, kind, status, cadence, priority, timezone, source, goalId), goals, active reminders (with channel, stepIndex, scheduledFor), summary counts (`activeOccurrenceCount`, `overdueOccurrenceCount`, `snoozedOccurrenceCount`, `activeReminderCount`, `activeGoalCount`), per-domain `owner` and `agentOps` sub-views, and a `schedule` insight for circadian state `[docs/rest/lifeops.md §GET /api/lifeops/overview]`.
- **Used by:** the dashboard, the LifeOps Today page, and chat queries that resolve to `LIFE.overview`.

### 2.7 Domain split (owner vs. agentOps)

Definitions, occurrences, goals, and workflows can be tagged with `domain ∈ {user_lifeops, agent_ops}` and `subjectType ∈ {owner, agent}` to keep agent-internal reminders separate from the user's own life ops `[contracts/LifeOpsOwnership]`.

### 2.8 Visibility scope and context policy

`visibilityScope`: `owner_only`, `agent_and_admin`, `owner_agent_admin`. `contextPolicy`: `never`, `explicit_only`, `sidebar_only`, `allowed_in_private_chat` — prevents internal items from leaking into LLM context inappropriately `[contracts/LIFEOPS_VISIBILITY_SCOPES]`.

---

## 3. Habits

### 3.1 Brush teeth — basic save flow

- **Actor:** User in a Telegram DM.
- **Turns:**
  1. User: `Help me brush my teeth at 8 am and 9 pm every day.`
  2. Agent reply contains one of `brush teeth`, `brushing habit`, `set that up` (preview only).
  3. User: `Yes, save that brushing routine.`
  4. Agent saves; the resulting definition title is "Brush teeth" (or aliased "Brush Teeth 8 + 9 Pm" / "Brush teeth 8 am & 9 pm").
- **Final state:** `definitionCountDelta = 1`, cadence `times_per_day` with slots `minuteOfDay: 480` (8:00) and `1260` (21:00), reminder plan attached.
- `[scenarios/brush-teeth-basic.json]`, `[scenario-ts/brush-teeth-basic.scenario.ts]`, `[test/lifeops-chat.live.e2e.test.ts]`.

### 3.2 Brush teeth — wake-up / bedtime phrasing (Discord)

- User: `make sure i actually brush my teeth when i wake up and before bed lol`
- After confirm, slots are labeled `Morning` / `Night` (480 / 1260); `GET /api/lifeops/definitions` confirms the row.
- `[scenarios/brush-teeth-bedtime-wakeup.json]`, `[scenario-ts/brush-teeth-bedtime-wakeup.scenario.ts]`.

### 3.3 Brush teeth — cancel before save

- User: `Help me brush my teeth in the morning and at night.` → preview.
- User: `Actually never mind, do not save it yet.` → response must NOT include `saved "brush teeth"`.
- Final: definitionCountDelta = 0.
- `[scenarios/brush-teeth-cancel.json]`.

### 3.4 Brush teeth — retry after backing out

- Cancel-then-restart: user issues the cancel, then later says `Okay actually yes, help me set up brushing my teeth in the morning and at night.` and confirms. One definition is saved.
- `[scenarios/brush-teeth-retry-after-cancel.json]`.

### 3.5 Brush teeth — repeat-confirm idempotency

- After saving, user says again `Yes, that's the schedule. Save it.` Agent must reply naturally (`saved`, `habit is saved`, `will remind you`) without creating a duplicate. Final delta = 1.
- `[scenarios/brush-teeth-repeat-confirm.json]`.

### 3.6 Brush teeth — Spanish

- User: `recuérdame cepillarme los dientes por la mañana y por la noche`
- Confirm: `sí, guárdalo`
- Same final cadence/slots as English.
- `[scenarios/brush-teeth-spanish.json]`, `[scenario-ts/brush-teeth-spanish.scenario.ts]`.

### 3.7 Brush teeth — night-owl phrasing

- User: `I'm usually up really late, but please help me brush my teeth when I wake up and before I finally go to bed.` Same final outcome as 3.1 even with night-owl framing.
- `[scenarios/brush-teeth-night-owl.json]`.

### 3.8 Brush teeth — smalltalk → preference update

- 6 turns: smalltalk warmup → smalltalk context (`forgetting brushing my teeth`) → preview-only request `Please make that into a routine named Brush teeth ... do not save it yet.` → confirm `That looks right. Save the Brush teeth routine.` → preference update `Now turn the Brush teeth reminder intensity down to minimal.`
- Final: definition exists; reminder intensity = `minimal`.
- `[scenarios/brush-teeth-smalltalk-preference.json]`, `[test/lifeops-chat.live.e2e.test.ts]` ("starts with smalltalk and eases into a real brush-teeth setup over multiple turns").

### 3.9 Shower weekly

- User: `Please remind me to shower three times a week.` → confirm. Final: cadence `weekly`, weekdays `[1, 3, 5]`, windows `["morning","night"]`.
- `[scenarios/shower-weekly-basic.json]`.

### 3.10 Shave weekly (formal phrasing)

- User: `Please remind me to shave twice a week.` → confirm. Cadence `weekly`, weekdays `[1, 4]`, windows `["morning"]`.
- `[scenarios/shave-weekly-formal.json]`.

### 3.11 Invisalign — weekday lunch

- User: `Please remind me about my Invisalign on weekdays after lunch.` → confirm. Title `Keep Invisalign in`, cadence `weekly`, weekdays `[1,2,3,4,5]`, windows `["afternoon"]`.
- `[scenarios/invisalign-weekday-lunch.json]`.

### 3.12 Vitamins with meals

- User: `Please remind me to take vitamins with lunch every day.` → confirm. Title `Take vitamins`, cadence `daily`, windows `["afternoon"]`.
- `[scenarios/vitamins-with-meals.json]`, `[test/lifeops-chat.live.e2e.test.ts]` ("creates a meal-window vitamin routine through chat").

### 3.13 Stretch — interval default

- User: `help me remember to stretch during the day` → confirm. Cadence `interval`, every 360 minutes, max 2/day, windows `["afternoon","evening"]`.
- `[scenarios/stretch-breaks.json]`.

### 3.14 Drink water — interval default frequency

- User: `help me remember to drink water` → confirm. Cadence `interval`, every 180 minutes, max 4/day, windows `["morning","afternoon","evening"]`.
- `[scenarios/water-default-frequency.json]`, `[test/lifeops-chat.live.e2e.test.ts]` ("adjusts reminder intensity through chat").

### 3.15 Workout habit with website blockers

- User: `Set up a workout habit every afternoon. Block X, Instagram, and Hacker News until I finish it, then unlock them for 60 minutes.` → confirm.
- Final: cadence `daily`, windows `["afternoon"]`, websiteAccess `unlockMode: fixed_duration`, `unlockDurationMinutes: 60`, websites include `x.com`, `twitter.com`, `instagram.com`, `news.ycombinator.com`.
- `[scenarios/workout-blocker-basic.json]`, `[test/lifeops-chat.live.e2e.test.ts]` ("creates a blocker-aware workout habit through chat and stores earned-access policy").

### 3.16 Adjust reminder intensity ("less reminders please")

- After a habit exists, user says `Remind me less about drink water.` Agent updates the per-definition preference to `minimal`. `GET /api/lifeops/reminder-preferences?definitionId=<id>` returns `effective.intensity = minimal`.
- `[test/lifeops-chat.live.e2e.test.ts]` ("adjusts reminder intensity through chat and persists the preference"); planner classifies `less reminders please` as `set_reminder_preference` `[test/lifeops-llm-extraction.live.test.ts]`.

### 3.17 Habit — full morning routine stack

- Compound habit suite: morning routine, night routine, missed-streak escalation, pause-while-traveling, sit-ups + push-ups daily counts.
- `[runtime-scenarios/lifeops.habits/habit.morning-routine.full-stack.scenario.ts]`, `habit.night-routine.full-stack.scenario.ts`, `habit.missed-streak.escalation.scenario.ts`, `habit.pause-while-traveling.scenario.ts`, `habit.sit-ups-push-ups.daily-counts.scenario.ts`.

### 3.18 Habit — pause while traveling

- Travel context detected → habit instances suppressed during the trip window without permanently archiving the definition.
- `[runtime-scenarios/lifeops.habits/habit.pause-while-traveling.scenario.ts]`.

---

## 4. Routines & multi-step daily flows

### 4.1 Morning brief — strict executive-assistant version

- **Trigger:** User asks for the morning brief in a DM.
- **Utterance (asserted verbatim):**
  > Build my executive-assistant morning brief. Use these headings exactly and in this order: Actions First, Today's Schedule, Unread By Channel, Pending Drafts, Overdue Follow-Ups, Documents And Forms. Use my connected email and calendar plus the pending work and recent cross-channel context you already have. Name the concrete items under each section. Do not ask follow-up questions and do not give me only a generic heading.
- **Pre-seeded fixtures:** pending draft in approval queue, overdue follow-up in `LifeOpsService.getDailyFollowUpQueue`, ≥4 triage rows including a clinic intake packet and a wire-cutoff thread `[test/assistant-user-journeys.morning-brief.e2e.test.ts]`.
- **System response:** Single brief covering all six sections; preserves the pending-draft request; preserves the follow-up; references named items (clinic intake packet, wire cutoff) and channel labels (telegram, discord) `[test/assistant-user-journeys.morning-brief.e2e.test.ts]`.
- **Coverage:** Suite B (`ea.inbox.daily-brief-cross-channel`), Journey #5 `[coverage-matrix #5]`.

### 4.2 Morning brief — light "what's on my plate" phrasing

- User: `What's on my plate this morning?`
- Brief surfaces unsent Gmail drafts that are awaiting sign-off (the `send_email` actions in the approval queue) `[test/daily-brief.drafts.e2e.test.ts]`. Coverage: Journey #6 `[coverage-matrix #6]`.

### 4.3 Daily left-today overview (multi-room)

- **Setup:** Two seeded one-off tasks (Pay rent due in 45m; Call mom due in 25m), each with `reminderPlan`.
- **Turns:**
  1. Discord: `what life ops tasks are still left for today?` → response includes `pay rent` and `call mom`.
  2. API: complete the "Call mom" occurrence with note `finished during live lifecycle coverage`.
  3. API overview no longer returns `Call mom`.
  4. Telegram: `what do i still need to do today in life ops?` → only `pay rent` remains; `call mom` is excluded.
  5. Discord: `anything else in my life ops list i need to get done today?` → still `pay rent`, never `call mom`.
- Planner traces include `<name>life</name>` and `overview`, exclude `<name>reply</name>`. `[scenarios/daily-left-today-variants.json]`.

### 4.4 Night brief / end-of-day

- The CHECKIN action was deleted; morning brief (`0 8 * * *`) and night brief (`0 20 * * *`) are intended to run as scheduled tasks rather than planner-visible actions. The agent posts the rendered briefing to the owner's primary DM room. `runMorningCheckin` and `runNightCheckin` are still on `CheckinService` `[checkin-todo]`.

### 4.5 Wake / bedtime workflow scheduling

- Workflows can be scheduled `relative_to_wake`, `relative_to_bedtime`, `during_morning`, or `during_night` based on the circadian engine, with `requireRegularityAtLeast` and `stabilityWindowMinutes` to gate firing on `wake.confirmed` events `[contracts/LifeOpsWorkflowSchedule]`.

### 4.6 Multi-step composite habit (workout + blockers)

- See §3.15. Compound flow: habit creation, blocker armed during habit window, blocker auto-unlocks for 60m after completion.

---

## 5. Tasks (one-off)

### 5.1 One-off reminder with full timezone phrase

- User (Discord): `please set a reminder for april 17 2026 at 8pm mountain time to hug my wife`
- Final definition: title `Hug My Wife` (alias `Hug my wife`), cadence `once`, expectedTimeZone `America/Denver`, reminderPlan attached.
- `[scenarios/one-off-mountain-time.json]`, `[scenario-ts/one-off-mountain-time.scenario.ts]`, `[test/lifeops-llm-extraction.live.test.ts]` (extractTaskCreatePlan asserts `expectedTimeOfDay: "20:00"`, `expectedTimeZone: "America/Denver"`).

### 5.2 Snooze a task via chat

- Setup: seeded `Call dentist` task due in 10 minutes. Reminder fires (in_app, `delivered`).
- Turn (Discord): `snooze call dentist for 30 minutes`
- Planner trace contains `<name>life</name>` and `snooze`; reply contains `30`, `snooze`, or `later`.
- Overview after snooze: occurrence has `state=snoozed`. Reminder process before snooze expires returns `attempts: []`.
- `[scenarios/reminder-lifecycle-snooze.json]`, `[scenario-ts/reminder-lifecycle-snooze.scenario.ts]`.

### 5.3 Acknowledge → complete a task

- Same `Call dentist` setup. Reminder fires; user acknowledges via `POST /api/lifeops/reminders/acknowledge` (`ownerType=occurrence`); subsequent process at +41m returns `attempts: []`. Inspection shows `delivered` + `reminder_delivered` audit events, no `blocked_acknowledged`. User finally says (Discord) `what life ops tasks are still left for today?` and gets back `call dentist`. Then completes via `POST /api/lifeops/occurrences/{id}/complete` with note `done after the reminder fired`. `GET /api/lifeops/definitions/{id}` shows `totalCompletedCount: 1, currentOccurrenceStreak: 1`.
- `[scenarios/reminder-lifecycle-ack-complete.json]`.

### 5.4 Complete via natural-language utterance

- LLM classifier maps `I just brushed my teeth` → `complete_occurrence`; the agent finds the matching occurrence and completes it `[test/lifeops-llm-extraction.live.test.ts]`.

### 5.5 Skip an occurrence via chat

- `skip workout today` → planner classifies `skip_occurrence` and the agent invokes `POST /api/lifeops/occurrences/<id>/skip` (empty body) `[test/lifeops-llm-extraction.live.test.ts]`.

### 5.6 Snooze via planner

- `snooze that reminder` → `snooze_occurrence` operation `[test/lifeops-llm-extraction.live.test.ts]`.

### 5.7 Delete a definition by name

- `delete my meditation habit` → `delete_definition` operation `[test/lifeops-llm-extraction.live.test.ts]`.

### 5.8 LIFE action acceptance criteria (smoke)

- AC-1: action with explicit param creates `Brush teeth` twice-daily habit (`cadence.kind=times_per_day`, slot `08:00` and `21:00`).
- AC-2: snooze occurrence with `preset=30m` end-to-end via the action handler.
- AC-3: progressive daily routine (cadence + reminders + linear progression).
- AC-4: explicitly named weekly goal.
- AC-5: calendar reports not connected when Google is missing.
- AC-7: email reports not connected when Google is missing.
- Robustness: missing target returns a friendly error; missing title rejects; missing cadence rejects; phone capture without number rejects; empty intent rejects; action+intent disagreement → action param wins.
- `[test/life-smoke.integration.test.ts]`.

---

## 6. Goals

### 6.1 Sleep goal — grounding and confirm

- **Turn 1 (Telegram):** `I want a goal called Stabilize sleep schedule.`
  - Rubric: agent must NOT save; must ask for missing success definition (target bedtime, wake time, consistency window, time horizon, evidence signal).
- **Turn 2:** `I want that to mean being asleep by 11:30 pm and awake around 7:30 am on weekdays, within 45 minutes, for the next month.`
  - Rubric: agent treats this as grounded enough to preview, restates the contract.
- **Turn 3:** `Yes, save that goal.`
  - Rubric: confirms saved.
- **Final state:** `goalCountDelta=1`, title `Stabilize Sleep Schedule`, status `active`, reviewState `idle`, has description, successCriteria, supportStrategy, `metadata.goalGrounding.groundingState = grounded`, `missingCriticalFields = []`.
- `[scenarios/goal-sleep-basic.json]`, `[scenario-ts/goal-sleep-basic.scenario.ts]`, `[test/lifeops-chat.live.e2e.test.ts]` ("creates a health-adjacent goal through chat").

### 6.2 Goal grounding — refusal to save title-only goal

- LLM extractor returns `mode=respond, groundingState=partial, missingCriticalFields.length > 0` for `I want a goal called Stabilize sleep schedule` `[test/lifeops-llm-extraction.live.test.ts]`.

### 6.3 Goal review — `how am I doing on my marathon goal`

- LLM extractor classifies as `review_goal`. The handler returns a `LifeOpsGoalReview` containing linkedDefinitions, activeOccurrences, overdueOccurrences, recentCompletions, suggestions, audits, summary `[contracts/LifeOpsGoalReview]`.

### 6.4 Goal create — `I want to learn guitar this year`

- Classified as `create_goal` `[test/lifeops-llm-extraction.live.test.ts]`.

### 6.5 Goal "experience loop" / similar goals

- The `LifeOpsGoalExperienceLoop` returns similar past goals, their final review state, and carry-forward suggestions when the user creates a new one `[contracts/LifeOpsGoalExperienceLoop]`.

### 6.6 Weekly goal review

- `LifeOpsWeeklyGoalReview` aggregates `onTrackCount`, `atRiskCount`, `needsAttentionCount`, `idleCount`, and per-bucket goal reviews `[contracts/LifeOpsWeeklyGoalReview]`.

### 6.7 Sleep window protection (calendar guard goal)

- User: `No calls between 11pm and 8am unless I explicitly approve it.`
- Agent uses `CALENDAR_PROTECT_WINDOW`. When a meeting crosses the protected window the agent asks before booking; explicit user override allowed.
- `[catalog/ice-bambam-executive-assistant ea.schedule.protect-sleep-window]`, `[runtime-scenarios/calendar/calendar.defend-time.protects-focus.scenario.ts]`, `[runtime-scenarios/executive-assistant/ea.schedule.protect-sleep-window.scenario.ts]`. Coverage: Journey #2 `[coverage-matrix #2]`.

---

## 7. Reminders & escalation ladder

### 7.1 Reminder channels supported

`in_app`, `sms`, `voice`, `telegram`, `discord`, `signal`, `whatsapp`, `imessage`, `email`, `push` `[contracts/LIFEOPS_REMINDER_CHANNELS]`.

### 7.2 Reminder lifecycle — process, deliver, acknowledge

- `POST /api/lifeops/reminders/process {now, limit}` — scheduler tick that fires due steps. Returns `attempts[]`.
- `POST /api/lifeops/reminders/acknowledge {ownerType, ownerId, acknowledgedAt, note}` — clears further deliveries on the same step.
- `GET /api/lifeops/reminders/inspection?ownerType=occurrence&ownerId=<id>` — returns the plan + attempts + audits, enabling the UI to explain escalation `[docs/rest/lifeops.md §Reminders]`, `[scenarios/reminder-lifecycle-ack-complete.json]`, `[scenarios/reminder-lifecycle-snooze.json]`.

### 7.3 Reminder review job — escalation without ack

- Setup: a stretch-reminder attempt is due for review.
- After processing: the reviewed attempt's `reviewStatus = escalated`, `deliveryMetadata.escalationReason = review_due_without_acknowledgement`, `deliveryMetadata[REMINDER_LIFECYCLE_METADATA_KEY] = escalation`. The escalation runs ahead of normal deliveries through `processReminders`.
- `[test/reminder-review-job.real.e2e.test.ts]`.

### 7.4 Reminder — owner replies on an unrelated topic

- If the owner sends `yes on the invoices` while a stretch reminder is awaiting review, the system records the response text but still escalates because the reply is unrelated to the reminder. Metadata: `REMINDER_REVIEW_DECISION=escalate`, captured response text, `reviewStatus=escalated`. `[test/reminder-review-job.real.e2e.test.ts]`.

### 7.5 Reminder review — observed-but-open vs closed

- Statuses include `unrelated`, `needs_clarification`, `no_response`, `resolved`, `escalated`, `clarification_requested` `[contracts/LifeOpsReminderReviewStatus]`. Only "closed" statuses (resolved / escalated) are excluded from the due-review queue. `[test/reminder-review-job.real.e2e.test.ts]`.

### 7.6 Reminder intensity preferences

- Three intensities: `minimal`, `normal`, `persistent`, `high_priority_only`. Compatibility shim accepts legacy `paused` / `low` / `high`. Sources: `default`, `global_policy`, `definition_metadata` `[contracts/LIFEOPS_REMINDER_INTENSITIES]`.
- API: `GET/PUT /api/lifeops/reminder-preferences[?definitionId=<id>]`.

### 7.7 iOS / macOS native alarm

- `reminder.alarm.sets-ios-alarm.scenario.ts`, `reminder.alarm.sets-macos-alarm.scenario.ts` — when a reminder is sufficiently time-critical, the agent creates a native alarm.
- `[runtime-scenarios/reminders/]`.

### 7.8 Cross-platform reminder synchronization

- `reminder.cross-platform.acknowledged-syncs.scenario.ts`: ack on phone clears the desktop reminder.
- `reminder.cross-platform.created-on-phone-fires-on-mac.scenario.ts`: a reminder created on iPhone fires later on the Mac.
- `reminder.cross-platform.fires-on-mac-and-phone.scenario.ts`: simultaneous fire on Mac + phone. `[runtime-scenarios/reminders/]`

### 7.9 Reminder escalation ladder

- `reminder.escalation.intensity-up.scenario.ts`: progressively louder.
- `reminder.escalation.silent-dismiss.scenario.ts`: silent dismiss path.
- `reminder.escalation.user-angry.scenario.ts`: user pushes back; intensity drops.
- `[runtime-scenarios/reminders/]`

### 7.10 Reminder lifecycle — dismiss

- `reminder.lifecycle.dismiss.scenario.ts`: explicit dismissal stops the ladder.

### 7.11 Domain-specific reminder cadence presets

- Invisalign tray every 10 days `[runtime-scenarios/reminders/reminder.invisalign-tray.every-10-days.scenario.ts]`.
- Stretch every 2 hours `reminder.stretch.every-2-hours.scenario.ts`.
- Vitamins daily morning `reminder.vitamins.daily-morning.scenario.ts`.
- Water hourly weekdays `reminder.water.hourly-weekdays.scenario.ts`.

### 7.12 Reminder attempt outcomes (operator reference)

`delivered`, `delivered_read`, `delivered_unread`, `blocked_policy`, `blocked_quiet_hours`, `blocked_urgency`, `blocked_acknowledged`, `blocked_connector`, `skipped_duplicate` `[contracts/LIFEOPS_REMINDER_ATTEMPT_OUTCOMES]`.

### 7.13 Quiet hours

- Per-plan policy `LifeOpsQuietHoursPolicy` (timezone, startMinute, endMinute, channels). Reminders blocked during quiet hours emit `blocked_quiet_hours` outcome.

### 7.14 Multi-device meeting reminder ladder (push)

- User: `Make sure I get reminded an hour before, ten minutes before, and right when it's starting.`
- The ladder fires native push at T-1h, T-10min, and T-0; ack on one device clears the others.
- `[catalog/ice-bambam-executive-assistant ea.push.multi-device-meeting-ladder]`, `[runtime-scenarios/executive-assistant/ea.push.multi-device-meeting-ladder.scenario.ts]`, `[runtime-scenarios/calendar/calendar.reminder.1hr-before|10min-before|on-the-dot.scenario.ts]`. Coverage: Journey #18 `[coverage-matrix #18]`.

---

## 8. Calendar journeys

### 8.1 Vague calendar follow-ups don't spawn task agents

- Discord:
  1. `do i have any flights this week?`
  2. `when do i fly back from denver`
  3. `yeah, probably next week?`
- All three planner traces must include `calendar_action` and exclude `create_task`, `spawn_agent`, `send_to_agent`, `list_agents`. Response must not contain `no active task agents`, `spawned`, or `scratch/`.
- `[scenarios/calendar-vague-followup.json]`, `[scenario-ts/calendar-vague-followup.scenario.ts]`. Same routing in `[test/lifeops-chat.live.e2e.test.ts]` ("routes itinerary questions toward CALENDAR instead of task agents").

### 8.2 Bundle meetings while traveling

- Setup: 3 NYC events seeded on Tue/Wed via the Google mock.
- User: `Bundle my NYC meetings into one trip.`
- The agent proposes a unified bundle but does NOT silently mutate the calendar — `requestLedger` shows zero non-GET writes during bundling. `[test/bundle-meetings.e2e.test.ts]`. Coverage: Journey #4 `[coverage-matrix #4]`.

### 8.3 Cancellation fee warning

- Setup: doctor's appointment in 2h with 24-hour cancellation policy in description ("Late cancellation fee: $150").
- User: `I'm thinking of skipping my doctor's appointment today — anything I should know?`
- Agent surfaces the cancellation fee and the policy. `[test/cancellation-fee.e2e.test.ts]`. Coverage: Journey #19 `[coverage-matrix #19]`. (it.todo: proactive surfacing at T-24h via background scheduler.)

### 8.4 Schedule merged-state — local + cloud preference

- Local merged schedule state is persisted. When a fresher cloud merged state is available, both the overview and reminder reads prefer the cloud version. `[test/schedule-merged-state.real.test.ts]`.

### 8.5 Calendar data layer (real PGLite)

- Listing events within a window (tomorrow), today's events, retrieving the connector grant for the seeded account, and empty-result behavior outside the seeded range. `[test/lifeops-calendar-chat.real.test.ts]`.

### 8.6 Recurring relationship time block ("Jill")

- User: `Need to book 1 hour per day for time with Jill.`
- Agent uses CALENDAR find-availability + create-recurring-block + confirm-change. Approval autonomous if inside free time and standing preference.
- `[catalog/ice-bambam-executive-assistant ea.schedule.daily-time-with-jill]`, `[scenario-ts/calendar-llm-eval-mutations.scenario.ts]`. Coverage: Journey #1 `[coverage-matrix #1]`.

### 8.7 Travel blackout mass reschedule

- User: `We're gonna cancel some stuff and push everything back until next month. All partnership meetings.`
- Mass cancel + reschedule; sends notifications to affected attendees via Gmail / messaging connectors. User-authorized bulk reschedule.
- `[catalog/ice-bambam-executive-assistant ea.schedule.travel-blackout-reschedule]`, `[runtime-scenarios/executive-assistant/ea.schedule.travel-blackout-reschedule.scenario.ts]`. Coverage: Journey #3 `[coverage-matrix #3]`.

### 8.8 Calendar planner — multi-language subaction matrix

- `extractCalendarPlanWithLlm` must classify, in EN/ES/FR/JA, the same subaction:
  - `feed` ("What's on my calendar today?" / "¿Qué tengo en el calendario hoy?" / "Qu'est-ce que j'ai dans mon agenda aujourd'hui?" / "今日の予定は何ですか？")
  - `next_event`, `search_events`, `create_event`, `delete_event`, `update_event`, `trip_window`.
- `[test/multilingual-action-routing.integration.test.ts]`, `[test/lifeops-llm-extraction.live.test.ts]`.

### 8.9 Calendar update preferences via SCHEDULING

- `CALENDAR.update_preferences` action persists preferences to scheduler-task metadata; rejects empty patches.
- `CALENDAR.check_availability` rejects invalid windows (`end <= start`).
- `[test/lifeops-scheduling.real.test.ts]`.

### 8.10 Scheduling — propose slots avoiding busy windows / blackouts / travel buffer

- `computeProposedSlots` returns 3 slots within preferred hours, avoiding busy intervals and blackouts.
- Honors travel buffer (busy window expanded).
- Replies for bundled travel slots include counterparties and travel city.
- `[test/lifeops-scheduling.real.test.ts]`.

### 8.11 Calendar create / cancel / reschedule (simple, with prep buffer, with travel time)

- `[runtime-scenarios/calendar/calendar.create.simple.scenario.ts]`, `calendar.create.travel-time.scenario.ts`, `calendar.create.with-prep-buffer.scenario.ts`, `calendar.cancel.simple.scenario.ts`, `calendar.reschedule.simple.scenario.ts`, `calendar.reschedule.conflict-detection.scenario.ts`.

### 8.12 Calendly handoff

- `[runtime-scenarios/calendar/calendar.calendly.navigate.scenario.ts]`. Capture availability via Calendly + reconcile bookings + single-use links `[catalog/lifeops-connector-certification connector.calendly]`.

### 8.13 Calendar dossier before a meeting

- User: `Give me the dossier for my next meeting.`
- Agent runs `CALENDAR_BUILD_DOSSIER` + `INBOX_SUMMARIZE_CHANNEL` against contacts + inbox + calendar.
- `[catalog/ice-bambam-executive-assistant ea.calendar.meeting-dossier-before-event]`.

### 8.14 LifeOpsNextCalendarEventContext provider

- Provider returns next event with start time, attendee count + names, location, conferenceLink, preparationChecklist, linkedMail (cache/synced) `[contracts/LifeOpsNextCalendarEventContext]`.

### 8.15 Calendar feed — multi-account, opt-out

- `LifeOpsCalendarSummary` exposes per-calendar `includeInFeed` (defaults true; opt-out only). `setLifeOpsCalendarIncluded` lets the user toggle.
- `[contracts/LifeOpsCalendarSummary]`, `[launchdocs/14 §Calendar listing]`.

---

## 9. Inbox & email triage

### 9.1 Gmail narrative sender routing

- User (Discord): `can you search my email and tell me if anyone named suran emailed me`
- Planner trace must include `gmail_action` AND `suran`, exclude `create_task`/`spawn_agent`/`send_to_agent`/`list_agents`.
- Response excludes `no active task agents`, `spawned`, `scratch/`.
- `[scenarios/gmail-suran-routing.json]`, `[scenario-ts/gmail-suran-routing.scenario.ts]`, `[test/lifeops-chat.live.e2e.test.ts]` ("routes sender-style Gmail searches toward MESSAGE across name and address variants" — covers `find the email from suran`, `look for any email from suran@example.com`, `search my inbox for messages from Suran Lee`, narrative variants, and `show all unread emails from alex@example.com`).

### 9.2 Gmail retry and refinement follow-up

- Three turns: initial search → `can you try the suran search again?` → `what about unread ones?`. Final retry must include `unread`/`replyneededonly`/`needs_response` plus `gmail_action` and `suran`.
- `[scenarios/gmail-retry-followup.json]`, `[test/lifeops-gmail-chat.live.e2e.test.ts]`.

### 9.3 Gmail — "find emails that contain invoice" / venue / agenda / reply-needed

- Broad filter routing: each must hit `triage_messages` action and preserve key terms (`invoice`, `alex` AND `venue`, `agenda`, `venue` for reply-needed).
- `[test/lifeops-chat.live.e2e.test.ts]` ("routes broad Gmail filters toward MESSAGE and preserves the key search terms").

### 9.4 Gmail reply draft creation

- User asks for a reply draft. Drafts use tone `brief|neutral|warm`; `bodyText` + `previewLines` returned; sendAllowed/`requiresConfirmation` flags surfaced.
- After the draft, `Send` requires explicit `confirmSend` to actually dispatch.
- `[contracts/CreateLifeOpsGmailReplyDraftRequest]`, `[contracts/SendLifeOpsGmailReplyRequest]`. `[test/lifeops-gmail-chat.live.e2e.test.ts]` ("recovers Gmail draft creation within three attempts when the first answer is weak").

### 9.5 Gmail batch reply drafts

- `POST /api/lifeops/gmail/batch-reply-drafts` produces multiple drafts at once, each with sendAllowed/requiresConfirmation. Send-all is `POST /api/lifeops/gmail/batch-reply-send` with `confirmSend`.

### 9.6 Inbox triage tables and digest ranking

- A fresh runtime auto-creates inbox triage tables; digest queries succeed on empty tables.
- Triage examples persist with object context (no nullable placeholders).
- `client_chat` send handler is registered so digest delivery doesn't crash.
- High-urgency triage entries are returned before low-urgency ones in `getUnresolved` and `getRecentForDigest`.
- `[test/lifeops-inbox-triage.integration.test.ts]`. Coverage: Journey #7 `[coverage-matrix #7]`.

### 9.7 Inbox merged feed (multi-channel)

- `GET /api/lifeops/inbox?channels=...&groupByThread=true&missedOnly=true&sortByPriority=true` returns merged messages across `gmail`, `x_dm`, `discord`, `telegram`, `signal`, `imessage`, `whatsapp`, `sms`. Supports `limit`, `chatTypeFilter` (dm/group/channel), `maxParticipants` (auto-hide groups >15), `gmailAccountId`, `cacheMode` (`read-through|refresh|cache-only`) `[contracts/GetLifeOpsInboxRequest]`.

### 9.8 Gmail spam review queue

- `LifeOpsGmailSpamReviewItem` with statuses `pending`, `confirmed_spam`, `not_spam`, `dismissed`. Fetched via `GET /api/lifeops/gmail/spam-review`; user transitions items via `PATCH .../{id} {status}`.

### 9.9 Gmail unresponded threads

- `GET /api/lifeops/gmail/unresponded?olderThanDays=N` returns `LifeOpsGmailUnrespondedThread[]` showing days waiting since the last outbound, used for follow-up nudging `[contracts/LifeOpsGmailUnrespondedFeed]`.

### 9.10 Gmail bulk operations with dry-run / proposal / execute

- `LifeOpsGmailManageExecutionMode` ∈ `proposal | dry_run | execute`. Statuses: `proposed | dry_run | approved | executed | partial | failed | cancelled`. Each manage call carries plan/approval/audit identifiers and a chunk cursor for safe execution. `confirmDestructive` gate required for trash/delete. Undo state tracks `LifeOpsGmailManageUndoStatus` (`available|completed|expired|failed|not_available`).
- `[contracts/LIFEOPS_GMAIL_BULK_OPERATIONS]`, `[contracts/LIFEOPS_GMAIL_MANAGE_*]`.

### 9.11 Gmail recommendations feed

- `LifeOpsGmailRecommendation` items: `reply | archive | mark_read | review_spam`, with rationale, sample messages, confidence, requiresConfirmation.

### 9.12 Gmail event ingestion → workflow trigger

- `POST /api/lifeops/gmail/ingest-event` dispatches `gmail.message.received` or `gmail.thread.needs_response` events into the workflow runner; returns `LifeOpsGmailEventIngestResult` with `workflowRunIds` `[contracts/IngestLifeOpsGmailEventRequest]`.

### 9.13 Daily-brief surface for unsent drafts

- See §4.2. Coverage: Journey #6.

### 9.14 Gmail recovery test (3-attempt)

- Live: reply-needed lookup must stabilize within 3 attempts (`venue`/`morgan` in response); draft creation similarly. `[test/lifeops-gmail-chat.live.e2e.test.ts]`.

### 9.15 Cross-platform inbox

- `[runtime-scenarios/messaging.cross-platform/cross-platform.inbox.scenario.ts]`: aggregates DMs across Gmail, Telegram, Discord, X DM, Signal, iMessage, WhatsApp.

### 9.16 Cross-platform same-person multi-platform

- `[runtime-scenarios/messaging.cross-platform/cross-platform.same-person-multi-platform.scenario.ts]`: groups messages from one person seen on multiple platforms.

### 9.17 Triage priority ranking

- `[runtime-scenarios/messaging.cross-platform/cross-platform.triage-priority-ranking.scenario.ts]`. Coverage Journey #7 (also).

### 9.18 Cross-platform escalation to user

- `[runtime-scenarios/messaging.cross-platform/cross-platform.escalation-to-user.scenario.ts]`: chat goes silent → escalate to call.

---

## 10. Travel

### 10.1 Capture booking preferences (turn 1) and reuse (turn 2)

- Turn 1 (Telegram): `For all future travel bookings: I prefer aisle seat, no checked bag, hotels under $300/night within 1 mile of the venue.` → `LifeOpsOwnerProfile.travelBookingPreferences` is updated.
- Turn 2: `Book my LA trip next month.` → response must NOT ask `what seat`, `what hotel budget`, `seat preference?`.
- `[test/booking-preferences.e2e.test.ts]`, `[catalog/ice-bambam-executive-assistant ea.travel.capture-booking-preferences]`. Coverage: Journey #12 `[coverage-matrix #12]`.

### 10.2 Book trip after approval

- User: `Jill confirmed it would be just you for LA and Toronto. I can start booking flights and hotel today if that's good with you.`
- `bookTravelAction` queues `book_travel` in the approval queue with payload (origin, destination, departureDate, passengers, calendarSync `{enabled, calendarId, title, timeZone}`). Response text contains `Queued travel approval for ...`. The Duffel offer-request and offer endpoints are pre-fetched but no order is placed.
- After owner says `yes, approve that booking`, `approveRequestAction` flips the approval to `done` AND executes the approved request: hits Duffel `/air/orders` and `/air/payments`, then POSTs the calendar event `London flight` to `googleapis.com/calendar/v3/calendars/primary/events` (`calendarSync` honored).
- Reject path: owner says `reject the London flight` → no orders, payments, or calendar mutations.
- `[test/book-travel.approval.integration.test.ts]`. Coverage: Journey #13 `[coverage-matrix #13]`.

### 10.3 Flight conflict detection and rebooking

- Setup: flight SFO→JFK landing 8 AM + board meeting 9 AM same day.
- User: `Can I make my Wednesday, May 20 board meeting given my morning flight to JFK that lands at 8 AM?`
- Agent either (a) queues an approval (`action=book_travel`, kind `flight`, ItineraryRef `SFO-JFK-earlier-2026-05-20`), or (b) replies with options/`earlier flight`/flight code, or (c) safely asks for details. Auto-booking is forbidden.
- `[test/flight-rebook.e2e.test.ts]`. Coverage: Journey #14 `[coverage-matrix #14]`.

### 10.4 Travel blackout reschedule (PRD §A)

- See §8.7.

### 10.5 Bundle meetings while traveling

- See §8.2.

### 10.6 Itinerary brief with links

- User: `Give me the itinerary and links for today.`
- Agent runs `EVENT_BUILD_ITINERARY_BRIEF` + `CALENDAR_LIST_UPCOMING`. Each itinerary item includes location, time, conference link, prep checklist.
- `[catalog/ice-bambam-executive-assistant ea.events.itinerary-brief-with-links]`.

### 10.7 Asset-deadline checklist before an event

- User: `Remind me what slides, bio, or title I still owe before the event.`
- `[catalog/ice-bambam-executive-assistant ea.events.asset-deadline-checklist]`.

### 10.8 Duffel direct + cloud-relay modes

- ENV `ELIZA_DUFFEL_DIRECT=1` switches the client to direct mode (requires `DUFFEL_API_KEY`). Otherwise it routes through the local relay at `${ELIZA_API_PORT}/api/lifeops/travel/relay/duffel`.
- Search supports `JFK→LHR` round-trips when `returnDate` is set; offer retrieval by ID; hold orders create + retrieve documents; balance payments.
- `[test/travel-duffel.integration.test.ts]`.

### 10.9 Gating travel by Cloud auth

- Feature flag `travel.book_flight` is OFF by default; flips ON automatically when CLOUD_AUTH reports authenticated. Stays OFF when CLOUD_AUTH is missing.
- `[test/lifeops-feature-flags.integration.test.ts]`.

### 10.10 x402 payment surface

- 402 responses are parsed for `paymentRequirements` and surfaced to the orchestrator (synthetic JSON body and WWW-Authenticate header forms).
- `[test/lifeops-feature-flags.integration.test.ts]`.

---

## 11. Follow-up repair (relationships)

### 11.1 Bump unanswered decision

- User: `Bump me again if I still haven't answered about those three events.`
- `FOLLOWUP_CREATE_RULE` + `FOLLOWUP_ESCALATE` + `INBOX_SUMMARIZE_CHANNEL`. Decision-nudger background job. Autonomous reminder generation.
- `[catalog/ice-bambam-executive-assistant ea.followup.bump-unanswered-decision]`. Coverage: Journey #9 `[coverage-matrix #9]`.

### 11.2 Repair missed call and reschedule (canonical journey)

- Setup: relationship `Frontier Tower` (Telegram, `@frontiertower_ops`, vendor, last contacted 21 days ago, `metadata.followupThresholdDays: 14`); follow-up due 2h ago with reason "Repair the missed walkthrough and reschedule"; triage entry with snippet "Sorry I missed your call earlier today. Can we reschedule the walkthrough this week?", urgency high, suggested response `Sorry I missed your call earlier. Thursday at 2pm or Friday at 11am works on my side if either helps for the walkthrough.`
- **Turn:** User (Telegram): `I missed a call with the Frontier Tower guys today. Need to repair that and reschedule if possible asap, but hold the note for my approval first.`
- Agent enqueues `send_message` request in approval queue with the suggested repair draft. Owner sees pending approval; approves with `Owner approved the Frontier Tower repair note.`. `executeApprovedRequest` dispatches the message; `dispatches[]` contains `walkthrough` text.
- After dispatch, the follow-up is marked complete via `service.completeFollowUp(followUpId)`.
- `[test/assistant-user-journeys.followup-repair.e2e.test.ts]`. Coverage: Journey #10 `[coverage-matrix #10]`.

### 11.3 Relationships rolodex CRUD

- `upsertRelationship({name, primaryChannel, primaryHandle, email, phone, notes, tags, relationshipType, lastContactedAt, metadata})` persists; `listRelationships({})` returns it.
- `logInteraction({relationshipId, channel, direction, summary, occurredAt, metadata})` updates `lastContactedAt`; `getDaysSinceContact(id) === 0` immediately after.
- `createFollowUp(...)` puts an entry in `getDailyFollowUpQueue({})`. `completeFollowUp(id)` removes it.
- Action surface: `RELATIONSHIP` with subactions `list_contacts`, `add_contact` (rejects missing fields with `MISSING_FIELDS`), `add_follow_up` (resolves contact by name with loose-text dueAt; output `dueAt` ISO contains `T`), `days_since` (resolves by `name`, `relationshipId` (treats non-UUID as alias), or `intent`).
- `[test/relationships.e2e.test.ts]`.

### 11.4 Relationship overdue detector (per-contact thresholds)

- User: `Who is overdue for follow-up?`
- `list_overdue_followups` respects `metadata.followupThresholdDays`. Threshold-Dana (16d, threshold 14) appears; Threshold-Evan (10d, threshold 14) does not.
- `[test/relationships.e2e.test.ts]`. Coverage: Journey #11 `[coverage-matrix #11]`.

### 11.5 Set follow-up cadence

- User: `Set Mina to every 14 days`
- Subaction `set_followup_threshold` persists `metadata.followupThresholdDays = 14` on the relationship. `[test/relationships.e2e.test.ts]`.

### 11.6 Mark follow-up done with `mark_followup_done`

- User: `They confirmed Thursday works. Mark the Frontier Tower Loop follow-up done and close the loop.`
- Updates relationship's `lastContactedAt` AND sets the linked follow-up to `status=completed`.
- `[test/relationships.e2e.test.ts]`.

### 11.7 Planner-vs-handler conflict — execute valid plan even when shouldAct=false

- If the planner LLM returns `subaction=days_since, shouldAct=false, relationshipId=<known>, response=...`, the handler still executes the subaction (data.noop !== true). `[test/relationships.e2e.test.ts]`.

### 11.8 Relationship congrats from daily brief

- See `[catalog/ice-bambam-executive-assistant ea.followup.relationship-congrats-from-daily-brief]` (mapped to Journey #11).

---

## 12. Documents, signatures, portals

### 12.1 Signature deadline tracking

- Setup: meeting in 48h with description `Requires signed NDA before meeting. DocuSign link: https://docusign.example/nda-123`.
- User: `I have a partnership kick-off meeting in 2 days that requires a signed NDA. Please initiate the signing flow.`
- Agent enqueues `sign_document` approval (documentId `nda-123`, documentName `Partnership kick-off NDA`, signatureUrl, deadline). Optionally an outbound nudge appears in Twilio or Gmail ledger.
- Coverage: Journey #15 `[coverage-matrix #15]`. `[test/signature-deadline.e2e.test.ts]`.
- `it.todo`: SMS escalation 4h before via background scheduler.

### 12.2 End-of-week document deadline escalation

- Setup: queued `sign_document` request with deadline = next Friday 5 PM, channel `sms`, reason `Document "NDA — Acme Corp" deadline is <date>. Unsigned as of <now>.`
- User: `I have an unsigned NDA due Friday — please escalate it to me now via SMS.`
- Agent emits at minimum a Twilio SMS in the request ledger (path matches `messages`).
- `it.todo`: 30-min wait → phone call; another wait → Discord.
- `[test/eow-escalation.e2e.test.ts]`. Coverage: Journey #17 `[coverage-matrix #17]`.

### 12.3 Speaker portal upload via browser automation

- User: `Upload my deck to the SXSW speaker portal.`
- When `ELIZA_BROWSER_WORKSPACE_URL` is set, browser-workspace ledger contains at least one `navigate` or `eval` call. Otherwise, no browser-workspace requests fire.
- `it.todo`: full portal form fill + upload.
- `[test/portal-upload.e2e.test.ts]`. Coverage: Journey #16 `[coverage-matrix #16]`.

### 12.4 Collect missing ID/credential artifact

- User receives `Could you send over an updated driver's license copy? The only one on file is expired.` Agent runs `DOC_COLLECT_ID_OR_FORM` + `DOC_REQUEST_APPROVAL`. Approval mode: ask before storing sensitive artifacts.
- `[catalog/ice-bambam-executive-assistant ea.docs.collect-id-copy-for-workflow]`.

### 12.5 Document review preserving voice (Samantha catalog "move 6")

- Agent flags mechanical corrections (`its → it's` for contraction), preserves stylistic markers ("comic intensity", "specific affectionate detail"), notes style risks ("fight its face — could flatten the author's voice"), recommends `create_draft_after_user_review`.
- `[mock/lifeops-samantha api/lifeops/documents/proofread]`.

### 12.6 Bulk email curation preview (move 4)

- Setup: `POST /api/lifeops/email/curation-preview {scope}` returns a curation plan with criteria (keep/archive/delete), counts, examples, and an `undoPlan: "restore removed labels from recorded history ids"`.
- Edge: too-broad request returns 400 `bulk_request_too_broad` with `safeDefault: preview_only` and `requiredInput: narrow by sender, date, label, or project`.
- `[mock/lifeops-samantha]`.

---

## 13. Self-control / app & website blockers

### 13.1 Block + unblock websites via API

- `PUT /api/website-blocker {websites: ["x.com","twitter.com"], durationMinutes: 1}` → `success:true`, request echoed.
- `GET /api/website-blocker/status` polls until `active:true`, `engine: "hosts-file"`, `requiresElevation: false`, `websites: ["x.com","twitter.com"]`.
- `DELETE /api/website-blocker` → `success:true, status.active:false, removed:Boolean`.
- `[test/selfcontrol-chat.live.e2e.test.ts]` ("blocks and unblocks websites through the real runtime API").

### 13.2 Block via chat with prior context

- Multi-turn: user provides context, then chat-driven block. Single-attempt strict and stochastic stability tests both call `runChatContextWebsiteBlockFlow`.
- `[test/selfcontrol-chat.live.e2e.test.ts]`.

### 13.3 Desktop website blocker through the dev orchestrator

- `bun run dev:desktop` boots a stack; `GET /api/permissions/website-blocking` returns `{id:"website-blocking", status:"granted"}`.
- After cleanup, `PUT /api/website-blocker {websites:["x.com","twitter.com"], durationMinutes:5}` → success → hosts file is updated to contain `0.0.0.0 x.com` and `0.0.0.0 twitter.com` but NOT subdomain matches like `0.0.0.0 api.x.com`.
- `DELETE` cleans hosts file.
- `[test/selfcontrol-desktop.live.e2e.test.ts]`.

### 13.4 Watch-mode (Vite renderer + blocker API)

- `bun run dev:desktop:watch` boots the Vite dev server + Electrobun renderer with HMR. UI markup contains `<div id="root">` or `<!doctype html>`; `GET /api/dev/stack` reflects API/UI ports.
- `[test/selfcontrol-desktop.live.e2e.test.ts]`.

### 13.5 Dev launcher boots blocker API and UI

- `[test/selfcontrol-dev.live.e2e.test.ts]` ("boots bun run dev with website blocker APIs and UI available").

### 13.6 Earned-access policy on a habit (workout blocker)

- See §3.15. Definition's `websiteAccess` policy:
  - `unlockMode`: `fixed_duration | until_manual_lock | until_callback`
  - `unlockDurationMinutes`, `callbackKey`, `reason`, `groupKey` `[contracts/LifeOpsWebsiteAccessPolicy]`.
- Agent re-locks via workflow action `relock_website_access {groupKey}` and resolves callbacks via `resolve_website_access_callback {callbackKey}`.

---

## 14. Group chat handoff

### 14.1 Detect three contacts asking the same question

- Setup: separate iMessage/Signal threads from Alice Nguyen, Bob Martinez, Priya Shah, each `Are you still organising the rooftop dinner? Count me in!`
- User (Telegram): `Are Alice Nguyen, Bob Martinez, and Priya Shah all asking about the same thing?`
- Agent proposes a group chat with all three; `MESSAGE_CREATE_GROUP_HANDOFF` + `MESSAGE_SEND_APPROVAL_REQUEST`.
- `[test/group-chat-handoff.e2e.test.ts]`, `[catalog/ice-bambam-executive-assistant ea.inbox.propose-group-chat-handoff]`. Coverage: Journey #8 `[coverage-matrix #8]`.

### 14.2 Group chat gateway scenarios

- `[runtime-scenarios/messaging.cross-platform/cross-platform.group-chat-gateway.scenario.ts]`.

---

## 15. Multi-channel & cross-channel search

### 15.1 Search a term across all chat platforms

- `runCrossChannelSearch({query: "ProjectAtlas", channels: ["memory","discord","telegram","imessage","gmail","signal","whatsapp"], limit: 5})`. Returns hits across at least Discord, Telegram, iMessage, Signal, WhatsApp; each hit has `citation.platform`, `timestamp`, non-empty `sourceRef`.
- Channels with no implementation appear under `unsupported` (e.g., `signal`, `whatsapp` in this fixture); Gmail returns either `unsupported` or `degraded`.
- `[test/cross-channel-search.integration.test.ts]`.

### 15.2 MESSAGE action returns clipboard-ready merged payload with citations

- User: `search for ProjectAtlas across all my channels` → handler returns `{success:true, text contains "ProjectAtlas", data.hits[].line, citation.platform/label, channelsWithHits.length >= 5}`.
- `[test/cross-channel-search.integration.test.ts]`.

### 15.3 Clarification fallback

- When no LLM is available and no query can be derived, the MESSAGE handler asks for clarification. `[test/cross-channel-search.integration.test.ts]`.

### 15.4 Cross-channel composition scenario

- `[scenario-ts/cross-channel-composition.scenario.ts]`: search → triage → reply across channels in one transcript.

---

## 16. Activity signals & screen context

### 16.1 Mobile signal ingestion (remote)

- `POST /api/lifeops/activity-signals` accepts:
  - `{source: "mobile_device", platform: "mobile_app", state: "active", observedAt, idleState: "unlocked", idleTimeSeconds:0, onBattery:true, metadata:{testRunId, deviceKind:"iphone"}}` → 201
  - `{source: "mobile_health", health: {source:"healthkit", permissions, sleep:{available, isSleeping, asleepAt, awakeAt, durationMinutes, stage}, biometrics, warnings:[]}}` → 201
- `GET /api/lifeops/activity-signals?sinceAt=...&limit=25` returns `signals[]` filtered by metadata.testRunId.
- `GET /api/lifeops/overview` shows the schedule insight derived from these signals.
- `[test/lifeops-activity-signals.remote.live.e2e.test.ts]`.

### 16.2 Browser-capture screen context

- `LifeOpsScreenContextSampler` polls a frame file produced by browser capture. Sampling produces `{source: "browser-capture", available:true, width, height, byteLength, framePath}`.
- Used to feed UI state into LLM prompts and inactivity detection.
- `[test/lifeops-screen-context.live.e2e.test.ts]`.

### 16.3 Activity profile telemetry families

- `device_presence_event`, `desktop_power_event`, `desktop_idle_sample`, `browser_focus_window`, `mobile_health_snapshot`, `mobile_device_snapshot`, `message_activity_event`, `status_activity_event`, `charging_event`, `screen_time_summary`, `manual_override_event`. Each has a typed `LifeOpsTelemetryPayload` variant `[contracts/LifeOpsTelemetryPayload]`.

### 16.4 Manual override ("just woke up" / "going to bed")

- `POST /api/lifeops/manual-override {kind, occurredAt?, note?}` force-transitions the circadian state machine with maximum reliability weight.
- `[contracts/CaptureLifeOpsManualOverrideRequest]`.

### 16.5 Circadian state insights

- `LifeOpsCircadianState` ∈ `awake | winding_down | sleeping | waking | napping | unclear` with named-rule firings (`circadianRuleFirings: [{name, contributes, weight, observedAt, reason}]`). Used to gate workflows scheduled `relative_to_wake`/`relative_to_bedtime`/`during_morning`/`during_night`.

### 16.6 Sleep regularity / personal baseline endpoints

- `GET /api/lifeops/sleep/regularity` → `{sri, classification, bedtimeStddevMin, wakeStddevMin, midSleepStddevMin, sampleSize, windowDays}`.
- `GET /api/lifeops/sleep/baseline` → median bedtime/wake hour, median sleep duration, stddevs, sampleSize.
- `GET /api/lifeops/sleep/history?windowDays=N&includeNaps=bool` → `{episodes:[], summary}`.
- `[contracts/LifeOpsSleepRegularityResponse, LifeOpsPersonalBaselineResponse, LifeOpsSleepHistoryResponse]`.

### 16.7 Schedule merged state (cloud preference)

- See §8.4.

### 16.8 LifeOps extension — daily report

- Browser companion produces a daily report of time-tracking by site / social breakdown / what-the-user-sees.
- `[runtime-scenarios/browser.lifeops/lifeops-extension.daily-report.scenario.ts]`, `lifeops-extension.reports-to-agent-ui.scenario.ts`, `lifeops-extension.see-what-user-sees.scenario.ts`, `lifeops-extension.time-tracking.per-site.scenario.ts`, `lifeops-extension.time-tracking.social-breakdown.scenario.ts`.

---

## 17. Approval queues & action gating

### 17.1 Approval queue lifecycle (real PGLite)

- Happy path: `enqueue → approve → markExecuting → markDone`.
- Reject path: `enqueue → reject` records resolver.
- `purgeExpired` moves past-due `pending` rows to `expired`.
- Hard rejection of invalid state transitions (e.g., from `done` back to `pending`).
- `byId(unknownId)` throws `ApprovalNotFoundError`.
- `[test/approval-queue.integration.test.ts]`.

### 17.2 Approval-gated dispatch through chat

- See §11.2 (Frontier Tower repair) and §10.2 (book travel). User's `yes, approve that booking` triggers `approveRequestAction` which executes `executeApprovedRequest`.

### 17.3 Action gating — MESSAGE always enabled (owner inbox)

- The `MESSAGE` action's `validate()` returns `true` even without an active LifeOps UI session, so the LLM can answer email/inbox questions in-chat. `[test/lifeops-action-gating.integration.test.ts]`.

### 17.4 Owner-only action surface

- The `RELATIONSHIP` action `validate()` returns `false` for non-owner senders and `true` for the agent itself (agent-self owner shortcut). `[test/lifeops-action-gating.integration.test.ts]`.

### 17.5 Plugin action surface (allow/deny)

- Allowed: `MESSAGE`, `CALENDAR`, `LIFE`, `RELATIONSHIP`, `BOOK_TRAVEL`, `RESOLVE_REQUEST`.
- Removed (will not appear in `actions`): `GMAIL_ACTION`, `INBOX`, `CALENDAR_ACTION`, `SCHEDULING`, `LIST_OVERDUE_FOLLOWUPS`, `MARK_FOLLOWUP_DONE`, `SET_FOLLOWUP_THRESHOLD`, `GENERATE_DOSSIER`, `COMPUTE_TRAVEL_BUFFER`, `REGISTER_BROWSER_SESSION`, `FETCH_BROWSER_ACTIVITY`, `CHECKIN`. `[test/lifeops-action-gating.integration.test.ts]`.

### 17.6 Channel policy upserts

- `POST /api/lifeops/channel-policies` body: `{channelType, channelRef, privacyClass, allowReminders, allowEscalation, allowPosts, requireConfirmationForActions, metadata}`. Channel types: `in_app | sms | voice | telegram | discord | signal | whatsapp | imessage | x | browser | email | push`. Privacy classes: `private | shared | public` `[contracts/LIFEOPS_CHANNEL_TYPES]`.

### 17.7 Phone consent capture

- `POST /api/lifeops/phone-consent` body: `{phoneNumber, consentGiven, allowSms, allowVoice, privacyClass, metadata}` enables SMS/voice reminders for that number. `[contracts/CaptureLifeOpsPhoneConsentRequest]`.

---

## 18. Identity merge (canonical person)

### 18.1 One person across Gmail, Signal, Telegram, WhatsApp

- Setup: 4 platform-specific entity rows seeded for `Priya Rao`. Before merge, the graph snapshot shows 4 separate people.
- After accepting the canonical merge proposal, the graph collapses to 1 person with `primaryEntityId` linking back to the seed.
- Person detail exposes 4 `memberEntityIds`, 4 identities, 4 `recentConversations`, 3 identityEdges; transcript includes `Gmail:`, `Signal:`, `Telegram:`, `WhatsApp:`.
- User asks (turn): `Show me everything Priya Rao has sent me recently across Gmail, Signal, Telegram, and WhatsApp. Treat it as one person and group the context by platform.`
- Agent groups context by platform; merge-failure assertion passes.
- `[test/relationships.e2e.test.ts]`, `[test/assistant-user-journeys.identity-merge.live.e2e.test.ts]`.

### 18.2 Contact resolution (Samantha "move 5")

- `POST /api/lifeops/contacts/resolve {query}` returns ranked candidates with `confidence`, `evidence[]`, `safeToSend`, plus a preferred channel (`provider, confidence, source`). When ambiguous, returns 409 `ambiguous_recipient` with `requiredInput: "which Alice?"`.
- `[mock/lifeops-samantha]`.

### 18.3 Identity observations (passive merging signals)

- The runtime captures identity observations to feed the merge graph; details in `lifeops/identity-observations.ts` and used by `getCanonicalIdentityGraph(runtime)`. `[test/relationships.e2e.test.ts]`.

---

## 19. Memory recall

### 19.1 Cross-channel preference recall

- Setup turns (Telegram): smalltalk + `i always prefer text reminders and i do not want phone-call reminders` + `text reminders only, never phone calls` + `i wear Invisalign during the day and i usually forget to put it back in after lunch` + `that invisalign thing is a real recurring pattern for me, especially on weekdays after lunch` + `gentle nudges work better for me than aggressive ones` + `can you keep those preferences in mind for later?`
- Memory pipeline:
  - Session summary persisted via `memoryService.getCurrentSessionSummary(roomId)`.
  - Reflection facts include keywords `text|phone|invisalign`.
  - `runtime.getRelationships({entityIds: [ownerId]})` returns ≥1 entry.
  - Long-term memories include `text|phone|invisalign`.
- Cross-channel turn (Discord, different room): `we switched channels. what reminder channel do i prefer, and what do i usually forget after lunch?`
- Response (normalized) must contain `text` AND `invisalign`.
- `[test/lifeops-memory.live.e2e.test.ts]` ("stores summaries, reflection facts, and long-term memories, then recalls them from another channel").

### 19.2 Default memory features enabled

- `runtime.character.advancedMemory === true`. Providers `SUMMARIZED_CONTEXT` and `LONG_TERM_MEMORY`. Actions `MEMORY_SUMMARIZATION`, `LONG_TERM_MEMORY_EXTRACTION`, `REFLECTION`.
- `[test/lifeops-memory.live.e2e.test.ts]` ("keeps advanced memory enabled by default").

### 19.3 Owner profile extraction, update, and protection

- Setup: baseline owner profile is "n/a" everywhere except updatedAt=null; persisted owner name in `eliza.json` is empty or `admin`.
- Turn 1 (Telegram): `Please silently update my Life Ops owner profile with these exact stable fields: name=Shaw, relationshipStatus=single, orientation=straight, gender=male, age=34, location=Denver.`
  - Profile: `name: shaw, relationshipStatus: single, orientation: straight/heterosexual, gender: male/man, age: 34, location: denver`. `partnerName` stays "n/a"; `updatedAt` not null. Persisted owner name in config contains `shaw`.
- Turn 2 (Discord): `Please silently update my Life Ops owner profile with these exact fields: relationshipStatus=partnered, partnerName=Alex, location=Boulder. Everything else stays the same.`
  - Profile: relationshipStatus=partnered, partnerName=alex, location=boulder. Other fields unchanged.
- Turn 3 (intruder Mallory in a different DM): claims `name is Mallory`, `married to Pat`, `41`, `Austin`. After 5s, owner profile is unchanged. `eliza.json` still contains `shaw`.
- `[test/lifeops-memory.live.e2e.test.ts]` ("extracts, persists, updates, and protects the owner profile across channels with a live model").

### 19.4 Multi-turn memory: smalltalk → preview → save

- See §3.8 / §4.1 / §6.1. Memory accumulates across turns; the final preference update mutates the saved definition's reminder preference.

### 19.5 Approved preference memory (Samantha "move 1b")

- `POST /api/lifeops/memory/preferences {key, value, source}` returns `{id, key, value, source, createdAt, mutable:true}`. `[mock/lifeops-samantha]`.

---

## 20. Connectors & permissions

### 20.1 Connector providers

`google, x, telegram, discord, twilio, signal, whatsapp, imessage, strava, fitbit, withings, oura` `[contracts/LIFEOPS_CONNECTOR_PROVIDERS]`.

### 20.2 Connector mode + side + execution target

- Modes: `local | remote | cloud_managed`.
- Sides: `owner | agent`.
- Execution targets: `local | cloud`.
- Source of truth: `local_storage | cloud_connection | connector_account`.

### 20.3 Side-aware capability policy

- Owner side = read-only assistive (`*.read` only). Agent side = read + send (full set). Enforced by `capabilitiesForSide(allCapabilities, side)` `[contracts/lifeops.ts]`.

### 20.4 Google capability set

`google.basic_identity`, `google.calendar.read/write`, `google.gmail.triage/send/manage` `[contracts/LIFEOPS_GOOGLE_CAPABILITIES]`.

### 20.5 Connector grants — choose preferred grant

- `POST /api/lifeops/connectors/google/select-preferred {side, mode}` flips `preferredByAgent` on a Google grant. `[contracts/SelectLifeOpsGoogleConnectorPreferenceRequest]`.

### 20.6 Disconnect

- `POST /api/lifeops/connectors/<provider>/disconnect {side, mode, grantId}` drops the grant. After disconnect: status reflects `connected:false, reason:"disconnected"`.

### 20.7 Reauthentication

- `POST /api/lifeops/connectors/google/start {grantId, capabilities, redirectUrl}` re-runs OAuth for an existing account. Pass `createNewGrant:true` to add an additional account instead.

### 20.8 Connector certification matrix (catalog)

- 15 connectors × axes: `core, missing-scope, rate-limited, disconnected, auth-expired, session-revoked, delivery-degraded, plugin-unavailable, retry-idempotent, hold-expired, transport-offline, blocked-resume`. Each scenario asserts capabilities like `read, draft, send-after-approval, degraded-auth, missing-send-scope, draft-hold, reauth-required` etc., and required final-check types: `draftExists, approvalRequestExists, messageDelivered, interventionRequestExists, clarificationRequested, selectedActionArguments, memoryWriteOccurred`. `[catalog/lifeops-connector-certification]`.

### 20.9 Discord browser-access ladder

- `LifeOpsDiscordConnectorStatus.dmInbox.visible` is the canonical "is the user actually seeing their Discord DMs" check. `nextAction` walks the user through getting to a logged-in DM inbox (browser companion install → permission → open Discord → log in → focus DM inbox).
- `[contracts/LifeOpsOwnerBrowserAccessStatus]`, `[contracts/LIFEOPS_OWNER_BROWSER_NEXT_ACTIONS]`.

### 20.10 Telegram verification (read + send)

- `POST /api/lifeops/connectors/telegram/verify {recentLimit, sendTarget, sendMessage}` returns `read.dialogCount, dialogs[]` and `send.ok, target, message, messageId` so the user can confirm the connector works end-to-end.

### 20.11 Discord verification

- Similar `verify` action for Discord; returns the active connector status plus an outbound send result.

### 20.12 X DM read

- `dmInbound:true` once `x.dm.read` capability is granted. Sync via `syncXDms()`, then read with `getXDms()`/`readXInboundDms()` `[contracts/LifeOpsXConnectorStatus]`.

### 20.13 Signal grant + send

- After pairing, owner-side grant carries `signal.read` + `signal.send` capabilities. `POST /api/lifeops/connectors/signal/send {recipient, text}` returns `{ok:true, timestamp}`.

### 20.14 WhatsApp transport split

- `transport ∈ "cloudapi" | "baileys" | "unconfigured"`. Inbound is always true (webhook). `outboundReady`/`inboundReady`/`serviceConnected` flags surfaced separately.

### 20.15 iMessage outbound probe

- `lifeops/imessage-outbound-probe.ts` confirms that the local bridge can actually deliver. Status row reflects degraded send-path when probe fails.

### 20.16 Connector degradation surfacing

- Each connector status carries `degradations?: LifeOpsConnectorDegradation[]` listing axes that are currently failing. `[contracts/LifeOpsConnectorDegradation]`.

### 20.17 Plaid + PayPal managed clients

- Subscription / payment connectors. `lifeops/paypal-managed-client.ts`, `lifeops/plaid-managed-client.ts` (referenced by source layout).

### 20.18 1Password / Proton Pass autofill bridge

- Owner can opt sites into the autofill whitelist; non-whitelisted sites are refused. `[runtime-scenarios/browser.lifeops/1password-autofill.whitelisted-gmail.scenario.ts]`, `1password-autofill.whitelisted-site.scenario.ts`, `1password-autofill.non-whitelisted-refused.scenario.ts`.

---

## 21. Health, money, screen time

### 21.1 Health summary

- `POST /api/lifeops/health/summary {provider, side, mode, days, startDate, endDate, metrics, forceSync}` → `{providers[], summaries:[{date, provider, steps, activeMinutes, sleepHours, calories, distanceMeters, heartRateAvg, restingHeartRate, hrvMs, sleepScore, readinessScore, weightKg, bloodPressure*, bloodOxygenPercent}], samples[], workouts[], sleepEpisodes[], syncedAt}`.
- `[contracts/LifeOpsHealthSummaryResponse]`.

### 21.2 Health connector start / disconnect / sync

- Start: `POST /api/lifeops/connectors/health/start {provider, side, mode, redirectUrl, capabilities}` → `{authUrl, redirectUri}`.
- Disconnect: `POST /api/lifeops/connectors/health/disconnect`.
- Sync: `POST /api/lifeops/connectors/health/sync`.

### 21.3 Sleep history page

- `GET /api/lifeops/sleep/history` returns episodes with `cycleType ∈ {nap|overnight|unknown}`, source `health|activity_gap|manual`, and confidence. Summary includes `cycleCount, averageDurationMin, overnightCount, napCount, openCount`.

### 21.4 Screen time daily roll-up

- `recordScreenTimeEvent({app, durationSeconds, ...})` inserts a session.
- `aggregateDailyForDate(date)` rolls sessions into daily totals.
- `getScreenTimeSummary(date)` returns top apps in descending order; OS login surfaces excluded.
- `getScreenTimeWeeklyAverageByApp()` returns structured per-day averages.
- `[test/screen-time.real.test.ts]`.

### 21.5 Browser focus → screen time

- `syncBrowserState(events)` persists browser focus windows as screen-time summaries. `[test/screen-time.real.test.ts]`.

### 21.6 SCREEN_TIME action surface

- `today` handler returns text + data. `summary` handler returns ranked items. `weekly_average_by_app` returns structured per-app weekly average.

### 21.7 Money / payments

- Plaid + PayPal managed clients; bill extraction (`bill-extraction.ts`); subscription playbooks (`subscriptions-playbooks.ts`); CSV import (`payment-csv-import.ts`); recurrence detection (`payment-recurrence.ts`); x402 inference-payment surface (§10.10).
- Subscription cancel scenarios (login-required / Google Play): `[runtime-scenarios/browser.lifeops/subscriptions.cancel-google-play.scenario.ts]`, `subscriptions.login-required.scenario.ts`.

---

## 22. Push notifications

### 22.1 Ntfy push delivery

- `sendPush({title, message, priority, tags, click, topic?})` POSTs to `${NTFY_BASE_URL}/<topic>` with `Title`, `Priority`, `Tags`, `Click` headers. Returns `{messageId, deliveredAt}`. Custom `topic` overrides `NTFY_DEFAULT_TOPIC`.
- `[test/notifications-push.e2e.test.ts]`.

### 22.2 Push config error path

- Without `NTFY_BASE_URL`, `readNtfyConfigFromEnv()` throws `NtfyConfigError`. `sendPush()` without baseUrl/topic throws `NtfyConfigError` immediately (no network call). 403 / network errors propagate as `Error`.
- `[test/notifications-push.e2e.test.ts]`.

### 22.3 Cancellation fee push (warning)

- See §8.3.

### 22.4 Stuck-agent push escalation

- Browser automation hits a CAPTCHA → SMS via Twilio → Twilio voice call requesting a remote-control session.
- `[test/stuck-agent-call.e2e.test.ts]`, `[catalog/ice-bambam-executive-assistant ea.remote.stuck-agent-calls-user]`. Coverage: Journey #20 `[coverage-matrix #20]`.

### 22.5 Multi-device meeting reminder ladder

- See §7.14.

---

## 23. Remote sessions

### 23.1 Start a remote session (T9a)

- Owner-only. Pairing-code-gated for non-local mode.
- `START_REMOTE_SESSION` action: requires explicit confirmation, returns `ingressUrl` only when a data plane is configured. Otherwise returns structured `data-plane-not-configured`.
- `[launchdocs/06]`, `[launchdocs/10]`.

### 23.2 List / revoke sessions

- `LIST_REMOTE_SESSIONS`, `REVOKE_REMOTE_SESSION` actions; persistence in the session ledger; survives runtime restart.

### 23.3 Pairing codes

- `lifeops/remote/pairing-code.ts` issues 6-digit codes with 5-minute TTL via in-process store. Missing/wrong/expired codes produce explicit errors; valid code allows session creation.

### 23.4 Tailscale data plane

- `tailscale-transport.ts` probes `tailscale serve`, reserves and releases endpoints. Local mode bypasses Tailscale.

### 23.5 Legacy REMOTE_DESKTOP

- Returns Tailscale/ngrok/VNC session URLs through `actions/remote-desktop.ts`. Routing layer sends `start/list/revoke` to the new T9a service; `status/end` stay on the legacy backend `[launchdocs/10]`.

### 23.6 Stuck-agent escalation (calls user via Twilio voice)

- See §22.4.

---

## 24. Settings & UX

### 24.1 Access page (compact source health)

- Page lists each source with status + next action. No internal jargon (capabilities/sleep/browser-companion-packages) on the primary surface.
- Page-level controls: `Run setup again`, `Disable LifeOps`.
- `[settings-ux §Access Header]`.

### 24.2 Browser profiles disclosure

- Compact "Your Browser" row shows status only by default; install/build/manual pairing details hidden behind disclosure. `[settings-ux §Browser Profiles]`.

### 24.3 Telegram phone-input progressive reveal

- Phone/code/password inputs do not appear until the user clicks Connect. Test-send verification UI removed from the primary surface. `[settings-ux §Telegram]`.

### 24.4 Removed sleep/capabilities panels

- Sleep model details and capability health panels were removed from Access; they live on their domain pages now. `[settings-ux §Removed Sleep And Capability Panels]`.

### 24.5 Feature flags

- `lifeops_features` table rejects unknown keys instead of silently skipping them; per-key state has `enabled, source, enabledBy, metadata, enabledAt`.
- Cloud-aware defaults: when `cloudLinked=true` (CLOUD_AUTH authenticated), `travel.book_flight` and `cloud.duffel` flip ON automatically.
- API: `service.list()`, `service.get(key)`, `service.enable(key, source, byAgent, metadata)`, `service.disable(key, ...)`.
- `[test/lifeops-feature-flags.integration.test.ts]`.

### 24.6 Reminder preferences endpoint

- `GET /api/lifeops/reminder-preferences[?definitionId=<id>]` returns `{global, definition?, effective}` with `intensity, source ∈ default|global_policy|definition_metadata, updatedAt, note}`.
- `PUT /api/lifeops/reminder-preferences {intensity, definitionId?, note?}`.

### 24.7 Email unsubscribe

- Unsubscribe types and flows in `lifeops/email-unsubscribe-types.ts` (referenced by `service-mixin-email-unsubscribe.ts`).

### 24.8 Domain-specific settings cards

- `AppBlockerSettingsCardProps {mode}` for `desktop|mobile|web`.
- `WebsiteBlockerSettingsCardProps {mode, permission, platform, onOpenPermissionSettings, onRequestPermission}` `[contracts/lifeops.ts]`.

---

## 25. REST API access flows

> Every endpoint represents a discoverable user-or-developer-facing capability. All paths are under `/api/lifeops/`. The runtime returns `503 Service Unavailable` if it is not ready `[docs/rest/lifeops.md §header]`.

### 25.1 Overview

- `GET /api/lifeops/overview` — dashboard overview (§2.6).

### 25.2 Definitions

- `GET /api/lifeops/definitions` — list all definitions for the agent.
- `POST /api/lifeops/definitions` — create. Required: `kind, title, cadence`. Optional: `description, originalIntent, timezone, priority, windowPolicy, progressionRule, reminderPlan, goalId, source, metadata`. Returns 201.
- `GET /api/lifeops/definitions/:id` — single.
- `PUT /api/lifeops/definitions/:id` — partial update. Includes `status ∈ active|paused|archived`.

### 25.3 Goals

- `GET /api/lifeops/goals` — list.
- `POST /api/lifeops/goals` — create. Required: `title`. Optional: `description, cadence, supportStrategy, successCriteria, status, reviewState, metadata`. Returns 201.
- `GET /api/lifeops/goals/:id` — single.
- `PUT /api/lifeops/goals/:id` — partial update.

### 25.4 Occurrences

- `POST /api/lifeops/occurrences/:id/complete {note?, metadata?}` — mark completed.
- `POST /api/lifeops/occurrences/:id/skip {}` — skip.
- `POST /api/lifeops/occurrences/:id/snooze {minutes? | preset?}` — snooze. Presets: `15m`, `30m`, `1h`, `tonight`, `tomorrow_morning`. Provide either `minutes` OR `preset`, not both.

### 25.5 Reminders

- `POST /api/lifeops/reminders/process {now?, limit?}` — scheduler tick.
- `POST /api/lifeops/reminders/acknowledge {reminderId, channel?}` — ack.
- `GET /api/lifeops/reminders/inspection?ownerType=occurrence&ownerId=<id>` — inspect ladder state.

### 25.6 Workflows

- `GET /api/lifeops/workflows` — list event-triggered workflows.
- `POST /api/lifeops/workflows {trigger, actions, title?, enabled?}` — create. Returns 201.

### 25.7 Connectors (Google)

- `POST /api/lifeops/connectors/google/start {side, mode, grantId?, createNewGrant?, capabilities, redirectUrl}` → `{authUrl, redirectUri}`.
- `GET /api/lifeops/connectors/google/status?side=<>&mode=<>` → `LifeOpsGoogleConnectorStatus`.
- `POST /api/lifeops/connectors/google/select-preferred {side, mode}`.
- `POST /api/lifeops/connectors/google/disconnect {side, mode, grantId}`.

### 25.8 Connectors (Signal)

- `POST /api/lifeops/connectors/signal/pair {side?}` → `{sessionId}`.
- `GET /api/lifeops/connectors/signal/pairing-status?sessionId=<id>` → `{state, qrDataUrl, error}`.
- `GET /api/lifeops/connectors/signal/status` → `LifeOpsSignalConnectorStatus`.
- `POST /api/lifeops/connectors/signal/stop` — abandon pairing.
- `POST /api/lifeops/connectors/signal/disconnect`.
- `POST /api/lifeops/connectors/signal/send {side?, recipient, text}`.
- `GET /api/lifeops/connectors/signal/messages?limit=N`.

### 25.9 Connectors (Telegram)

- `POST /api/lifeops/connectors/telegram/start {side, phone, apiId?, apiHash?}`.
- `POST /api/lifeops/connectors/telegram/submit {side, code?, password?}`.
- `POST /api/lifeops/connectors/telegram/verify {recentLimit, sendTarget, sendMessage}`.

### 25.10 Connectors (Discord, WhatsApp, X)

- Discord: `start {source}`, `send {channelId, text}`, `verify {channelId, sendMessage}`.
- WhatsApp: status / send routes (`send-message {to, text, replyToMessageId?}`); pairing handled via app-core WhatsApp routes with `authScope:"lifeops"`.
- X: `start`, `disconnect`, `post-create {text, confirmPost}`, `upsert {capabilities, grantedScopes, identity, metadata}` (status routes too).

### 25.11 Calendar

- `GET /api/lifeops/calendars` — multi-account list with `includeInFeed`.
- `PATCH /api/lifeops/calendars/:id/included {includeInFeed, side?, mode?, grantId?}`.
- `GET /api/lifeops/calendar/feed?...` — events for current window.
- `POST /api/lifeops/calendar/events` — create event.
- `PATCH /api/lifeops/calendar/events/:id` — update.
- `GET /api/lifeops/calendar/next` — next event with prep + linked mail.

### 25.12 Gmail

- `GET /api/lifeops/gmail/triage?...` — `LifeOpsGmailTriageFeed`.
- `GET /api/lifeops/gmail/search?query=...&replyNeededOnly=...`.
- `GET /api/lifeops/gmail/recommendations`.
- `GET /api/lifeops/gmail/spam-review?status=...`.
- `PATCH /api/lifeops/gmail/spam-review/:id {status}`.
- `GET /api/lifeops/gmail/unresponded?olderThanDays=N`.
- `POST /api/lifeops/gmail/draft {messageId, tone, intent, conversationContext?}`.
- `POST /api/lifeops/gmail/batch-reply-drafts`.
- `POST /api/lifeops/gmail/send-reply {messageId, bodyText, confirmSend}`.
- `POST /api/lifeops/gmail/send-message {to, cc, bcc, subject, bodyText, confirmSend}`.
- `POST /api/lifeops/gmail/batch-reply-send {confirmSend, items[]}`.
- `POST /api/lifeops/gmail/manage` — bulk operations with executionMode (proposal/dry_run/execute), confirmDestructive, undo.
- `POST /api/lifeops/gmail/ingest-event {messageId, eventKind, occurredAt, maxWorkflowRuns}`.

### 25.13 Inbox

- `GET /api/lifeops/inbox?channels=...&groupByThread=true&missedOnly=true&sortByPriority=true&limit=...&cacheMode=read-through|refresh|cache-only`.

### 25.14 Activity signals

- `POST /api/lifeops/activity-signals` — ingest source-tagged signals (mobile/desktop/connector/iMessage/health).
- `GET /api/lifeops/activity-signals?sinceAt=...&limit=...` — list.

### 25.15 Manual override

- `POST /api/lifeops/manual-override {kind: "going_to_bed"|"just_woke_up", note?}`.

### 25.16 Sleep

- `GET /api/lifeops/sleep/regularity`, `/baseline`, `/history`.

### 25.17 Health connectors

- `POST /api/lifeops/connectors/health/start|disconnect|sync`.
- `GET /api/lifeops/connectors/health/status`.
- `POST /api/lifeops/health/summary`.

### 25.18 Channel policies + phone consent

- `POST /api/lifeops/channel-policies`; `POST /api/lifeops/phone-consent`.

### 25.19 Reminder preferences

- `GET/PUT /api/lifeops/reminder-preferences[?definitionId=<id>]`.

### 25.20 Website blocker

- `PUT /api/website-blocker {websites, durationMinutes}`.
- `GET /api/website-blocker/status`.
- `DELETE /api/website-blocker`.

### 25.21 Browser companion routes (moved out)

- `/api/browser-bridge/*` lives in `@elizaos/plugin-browser-bridge`. LifeOps requires that plugin to be loaded for the browser companion UI to function `[launchdocs/14 §P3]`.

### 25.22 Feature flag routes

- `GET /api/lifeops/features` — list with state.
- `POST /api/lifeops/features/:key/enable {source, metadata}`.
- `POST /api/lifeops/features/:key/disable`.

### 25.23 Approval queue

- `POST /api/lifeops/approval-queue/enqueue` (typically internal).
- `GET /api/lifeops/approval-queue?subjectUserId=<>&state=pending|done|expired&action=<>` — list.
- `POST /api/lifeops/approval-queue/:id/approve {resolvedBy, resolutionReason}`.
- `POST /api/lifeops/approval-queue/:id/reject {resolvedBy, resolutionReason}`.

### 25.24 Rate limits

- Sensitive sends and connector writes have dedicated buckets — Gmail send is 2/min, generic outbound messaging is 5/min `[launchdocs/14]`.

---

## 26. Workflows (event-triggered)

### 26.1 Event kinds

- `calendar.event.ended`, `gmail.message.received`, `gmail.thread.needs_response`, `lifeops.sleep.onset_candidate`, `lifeops.sleep.detected`, `lifeops.sleep.ended`, `lifeops.wake.observed`, `lifeops.wake.confirmed`, `lifeops.nap.detected`, `lifeops.bedtime.imminent`, `lifeops.regularity.changed` `[contracts/LIFEOPS_EVENT_KINDS]`.

### 26.2 Workflow create — calendar.event.ended

- User: configure a workflow that fires when a meeting ends — for example, drafting a follow-up note or summarizing the meeting.
- Filters: calendarIds, titleIncludesAny, minDurationMinutes, attendeeEmailIncludesAny.
- `[runtime-scenarios/lifeops.workflow-events/workflow.event.calendar-ended.create.scenario.ts]`, `workflow.event.calendar-ended.fires.scenario.ts`, `workflow.event.calendar-ended.filter-mismatch.scenario.ts`.

### 26.3 Workflow actions

- `create_task`, `relock_website_access {groupKey}`, `resolve_website_access_callback {callbackKey}`, `get_calendar_feed`, `get_gmail_triage`, `get_gmail_unresponded`, `get_health_summary`, `dispatch_workflow {workflowId, payload}`, `summarize {sourceKey, prompt}`, `browser {sessionTitle, actions[]}`. `[contracts/LifeOpsWorkflowAction]`.

### 26.4 Workflow permission policy

- `allowBrowserActions, trustedBrowserActions, allowXPosts, trustedXPosting, requireConfirmationForBrowserActions, requireConfirmationForXPosts` `[contracts/LifeOpsWorkflowPermissionPolicy]`.

### 26.5 Browser session in a workflow

- `LifeOpsBrowserSession` flows: `awaiting_confirmation → queued → running → done|cancelled|failed`. Each `LifeOpsBrowserAction` carries `accountAffecting` and `requiresConfirmation` flags. State-changing browser actions are rejected unless `canControl=true` `[contracts/LifeOpsBrowserSession, LifeOpsBrowserAction]`, `[launchdocs/14]`.

### 26.6 Long-running multi-hop workflow (Samantha "move 7")

- `POST /__mock/lifeops/samantha/tasks` returns `{task: {taskId, scenarioId, status:"queued", step, percentComplete:0, nextPollMs:900000}, taskId, pollUrl}`.
- Status polled at `GET /__mock/lifeops/samantha/tasks/:id` (`status:"running"`, `percentComplete:45`, `step:"Checked Gmail and GitHub; packet is still missing."`, `idempotencyKey:"vendor-packet-priya-update"`).
- Advance to `waiting_for_input` when `Two possible packet threads were found; user confirmation is required.`
- `[mock/lifeops-samantha]`.

### 26.7 Workflow scheduling kinds

- `manual`, `once {runAt, timezone}`, `interval {everyMinutes, timezone}`, `cron {cronExpression, timezone}`, `relative_to_wake / relative_to_bedtime / during_morning / during_night / event` `[contracts/LifeOpsWorkflowSchedule]`.

---

## 27. Multilingual coverage

### 27.1 LIFE extractor — multilingual classification

- For each operation, the LLM classifier must produce the same operation across EN/ES/FR/JA:
  - `create_definition`: `Remind me to brush my teeth every night` / `Recuérdame cepillarme los dientes cada noche` / `Rappelle-moi de me brosser les dents tous les soirs` / `毎晩、歯磨きをするようにリマインドして`
  - `complete_occurrence`: `I just brushed my teeth` / `Acabo de cepillarme los dientes` / `Je viens de me brosser les dents` / `歯磨きを済ませた`
  - `query_overview`: `What do I still need to do today?` / `¿Qué me queda por hacer hoy?` / `Qu'est-ce qu'il me reste à faire aujourd'hui ?` / `今日、まだやることは何？`
- `[test/multilingual-action-routing.integration.test.ts]`.

### 27.2 CALENDAR planner — multilingual classification

- 7 commands × 4 languages (`feed`, `next_event`, `search_events / flight`, `create_event`, `delete_event`, `update_event`, `trip_window`).
- `[test/multilingual-action-routing.integration.test.ts]`.

### 27.3 Onboarding affect (Samantha "move 1")

- `POST /api/lifeops/intake/utterance {text}` returns `{affect: {observation, confidence, basis}, persistence:{allowed:false, reason:"ephemeral affect only"}, clarifyingQuestion:"I may be hearing some hesitation. Would you agree with that?", sourceText}`.
- Used during onboarding to read voice affect without persisting it.
- `[mock/lifeops-samantha]`.

### 27.4 Permissioned context scan (Samantha "move 3")

- `POST /api/lifeops/context/scan {scope}` → `{scanId, scope, buckets:{urgent[], soon[], waiting[], ignore[]}, requiresApproval:["bulk archive","external send"]}`. Provider-down edge: 503 with `partialResults:{github:"available", browser-workspace:"available"}`.

---

## 28. Suspected-but-unconfirmed flows

These are mentioned in catalogs but their exact runtime behavior was not directly observed in the e2e tests during this review. They are included so the architectural cleanup pass does not miss them.

### 28.1 Recurring "time with X" calendar block

- `[catalog/ice-bambam-executive-assistant ea.schedule.daily-time-with-jill]` lists `CALENDAR_FIND_AVAILABILITY`, `CALENDAR_CREATE_RECURRING_BLOCK`, `CALENDAR_CONFIRM_CHANGE`. Coverage marked "extension pending" `[coverage-matrix #1]`.

### 28.2 Sleep onset candidate / sleep ended workflow triggers

- Event kinds defined in contracts; specific scenario JSONs not found.

### 28.3 Imessage outbound-probe-driven activity inference

- `imessage-outbound-probe.ts` is referenced; no end-to-end scenario shows the user-facing surface where probe failure yields a degraded send-path indicator beyond `[settings-ux §iMessage]`.

### 28.4 Privacy egress filter user-visible behavior

- `lifeops/privacy-egress.ts`/`privacy.ts`/`redact-sensitive-data.ts` exist; a user-facing "redacted" surface or audit trail is not directly visible in the test corpus.

### 28.5 Voice affect / voice-call action

- `lifeops/voice-affect.ts` and `actions/voice-call.ts` exist; specific journey of "agent calls user via voice" beyond the stuck-agent escalation (§22.4) is not directly demonstrated in e2e tests.

### 28.6 Document review service end-to-end

- `lifeops/document-review.ts` exists. Beyond the Samantha mock proofread response (§12.5), the user-visible flow ("user pastes a doc → agent returns a marked-up review") is not directly tested.

### 28.7 Scheduling negotiation lifecycle (proposals_sent → confirmed)

- `LIFEOPS_NEGOTIATION_STATES` defined in contracts; the user-facing flow where the agent negotiates with a counterparty over Calendly + email is partially covered by `calendar.scheduling-with-others.propose-times.scenario.ts` and `ask-preferences.scenario.ts` but not exercised end-to-end in `test/`.

### 28.8 Connector "stretch breaks" daily report from browser companion

- `[runtime-scenarios/browser.lifeops/lifeops-extension.daily-report.scenario.ts]` exists; the user-facing daily-report UX content was not directly read.

### 28.9 Computer-use action (LifeOps wrapper)

- `plugins/app-lifeops/src/actions/computer-use.ts` wraps the plugin-computeruse actions with LifeOps owner-only gating + policy `[launchdocs/12 §Plugin wiring]`. End-to-end user-visible computer-use journey is in `plugin-computeruse` rather than this plugin.

### 28.10 Subscriptions cancel flows

- `subscriptions.cancel-google-play.scenario.ts` and `subscriptions.login-required.scenario.ts` exist; specific final-check assertions were not read in this pass.

### 28.11 Reminder review status `clarification_requested` user flow

- Status enum value exists `[contracts/LifeOpsReminderReviewStatus]`; the test corpus exercises `escalated`/`unrelated`/`needs_clarification` flows but the explicit `clarification_requested` state-transition was not read end-to-end.

### 28.12 X DM inbound read-through

- Capability exists (`x.dm.read`, `dmInbound`); a complete end-to-end user-visible "agent reads X DMs into the inbox" journey was not observed in the e2e corpus.

### 28.13 Browser computer-use click-captcha-via-user

- `[runtime-scenarios/browser.lifeops/browser.computer-use.click-captcha-via-user.scenario.ts]` and `browser.computer-use.agent-fails-calls-user-for-help.scenario.ts` exist; partial test exercises Journey #20 path but full flow not directly read.

### 28.14 Bulk LifeOps reviews

- `lifeops/bulk-review.ts` and `service-mixin-status.ts` reference review surfaces beyond reminders + goals; not exercised end-to-end in the read tests.

### 28.15 Health-bridge owner sleep override

- Owner can manually mark a sleep episode (`source: "manual"` in `LifeOpsSleepHistoryEpisode`); the explicit user-facing manual-sleep-override surface beyond `manual_override_event` (§16.4) was not directly observed.

---

## Cross-reference: PRD Journeys 1–20 (canonical Suite map)

| ID | Journey name | Section in this doc | Coverage |
|---|---|---|---|
| 1 | Recurring relationship time (e.g. weekly Jill block) | §8.6 | covered (extension pending) |
| 2 | Sleep window protection (reject 7am meeting) | §6.7, §8.7 | covered (extension pending) |
| 3 | Travel blackout reschedule (bulk cancel) | §8.7 | covered (extension pending) |
| 4 | Bundle meetings while traveling (NYC) | §8.2 | covered |
| 5 | Daily brief cross-channel | §4.1 | covered |
| 6 | Daily brief includes unsent drafts | §4.2, §9.13 | covered |
| 7 | Priority ranking — urgent before low-priority | §9.6 | covered (extension pending) |
| 8 | Group chat handoff | §14.1 | covered |
| 9 | Bump unanswered decision | §11.1 | covered |
| 10 | Repair missed call and reschedule | §11.2 | covered |
| 11 | Relationship overdue detector | §11.4 | covered |
| 12 | Capture travel booking preferences | §10.1 | covered |
| 13 | Book trip after approval | §10.2 | covered |
| 14 | Flight conflict detection and rebooking | §10.3 | covered |
| 15 | Signature deadline tracking | §12.1 | covered |
| 16 | Speaker portal upload via browser automation | §12.3 | covered |
| 17 | End-of-week document approval escalation | §12.2 | covered |
| 18 | Multi-device meeting reminder ladder | §7.14 | covered |
| 19 | Cancellation fee warning | §8.3 | covered |
| 20 | Stuck agent calls user (browser blocked → phone) | §22.4 | covered |

All 20 PRD journeys are present; Mockoon environments per row are listed in the canonical matrix `[coverage-matrix]`.

---

## Cross-reference: Connector certification axes (15 connectors)

Each connector carries at least the `core` axis plus an additional degraded axis. Final-check shapes vary by axis (e.g., `interventionRequestExists`, `clarificationRequested`, `messageDelivered`, `selectedActionArguments`, `memoryWriteOccurred`, `draftExists`, `approvalRequestExists`).

| Connector | Required axes | Sample capabilities |
|---|---|---|
| gmail | core, missing-scope | read, draft, send-after-approval, degraded-auth, missing-send-scope, draft-hold, reauth-required |
| google-calendar | core, rate-limited | availability, create, reschedule, cancel, conflict-repair, retry-safe-write |
| calendly | core, disconnected | availability-handoff, booking-reconciliation, single-use-link, reconnect-request |
| discord | core, disconnected | inbound-fetch, reply-draft, send, thread-context, deep-link |
| telegram | core, auth-expired | inbound-fetch, reply-draft, send, thread-context, deep-link |
| x-dm | core, disconnected | dm-read, dm-write |
| signal | core, session-revoked | session pairing, send |
| whatsapp | core, delivery-degraded | send, webhook inbound, transport split |
| imessage | core, plugin-unavailable | local bridge availability, FDA fallback |
| twilio-sms | core, retry-idempotent | send, idempotency |
| twilio-voice | core, retry-idempotent | call, idempotency |
| google-drive-docs-sheets | core, missing-scope | read, edit |
| travel-booking | core, hold-expired | offer search, hold, payment, hold-expiry rebook |
| notifications | core, transport-offline | push delivery, transport fallback |
| browser-portal | core, blocked-resume | navigate, eval, snapshot, blocked-resume escalation |

`[catalog/lifeops-connector-certification]`

---

## Cross-reference: Samantha 7 onboarding "moves"

- **move-01-intake-voice-affect** — onboarding utterance + transient voice affect.
- **move-02-identity-and-explanation** — identity verification + explanation of capabilities.
- **move-03-permissioned-context-scan** — scoped scan across providers, returns urgent/soon/waiting/ignore.
- **move-04-email-bulk-curation** — bulk curation preview with keep/archive/delete; bounded sample; undo plan.
- **move-05-contact-resolution** — name-to-canonical-contact resolution with safe-to-send / required-input fallback.
- **move-06-document-review-preserve-voice** — voice-preserving proofread with explicit style risk flags.
- **move-07-proactive-multihop-and-long-running** — long-running task with poll/advance; idempotency key; waiting_for_input transitions.

`[mock/lifeops-samantha]`

---

End of canonical reference.
