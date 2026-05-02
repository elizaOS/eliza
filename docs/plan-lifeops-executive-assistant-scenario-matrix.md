# Plan: LifeOps Executive Assistant Scenario Matrix

Status: Draft  
Last updated: 2026-04-17

## Goal

Turn the real assistant behaviors from the `ice bambam` transcript into executable scenario coverage for Eliza `LifeOps`.

This plan is narrower than the full unified scenario matrix plan. It focuses on **executive-assistant composition**:

- inbox triage
- scheduling and time defense
- follow-up persistence
- travel and event operations
- docs and sign-off handling
- cross-device reminders and escalation

The transcript-derived machine-readable backlog lives at:

- `test/scenarios/lifeops/_catalogs/ice-bambam-executive-assistant.json`

The transcript-derived executable suite now lives at:

- `test/scenarios/executive-assistant/`

The Gmail/inbox-zero review and expanded LLM scenario matrix lives at:

- `docs/plans/2026-04-22-gmail-lifeops-integration-review.md`

Current footprint:

- 22 transcript-derived scenario files
- one machine-readable catalog
- one PRD
- one scenario-plan doc

## Transcript-Derived Operating Loop

The transcript shows one repeated loop:

1. Intake new inbound from one or more platforms.
2. Classify urgency and relationship importance.
3. Ask for a decision if a human judgment is needed.
4. Execute quickly once approved.
5. Push reminders when silence becomes risk.
6. Repair misses with reschedules, apology drafts, or alternative options.
7. Collapse everything into daily briefs and upcoming reminders.

The test matrix needs to verify that loop end-to-end, not just each isolated feature.

## Architecture Invariants From PRD Review

The scenario plan should enforce the architecture, not just the behavior.

The executive-assistant suite must prove:

1. Semantic routing is LLM-extracted.
   Tests should not pass if a flow only works because of keyword matching, regex routing, sender-name overrides, or channel-name rules.

2. Action execution is typed.
   Each scenario should verify the selected domain action and its typed arguments, not just the final assistant prose.

3. Connector behavior is capability-driven.
   The same scenario intent should execute through different connectors without changing the semantic planner.

4. Background work uses the same stack.
   Cron handlers, reminder ladders, and connector ingest paths must exercise the same extraction, planning, approval, and action pipeline as live chat turns.

## What Already Exists In The Repo

The repo already has strong scenario coverage surfaces that can be reused:

### Calendar

- `test/scenarios/calendar/calendar.create.simple.scenario.ts`
- `test/scenarios/calendar/calendar.reschedule.simple.scenario.ts`
- `test/scenarios/calendar/calendar.reschedule.conflict-detection.scenario.ts`
- `test/scenarios/calendar/calendar.create.travel-time.scenario.ts`
- `test/scenarios/calendar/calendar.create.with-prep-buffer.scenario.ts`
- `test/scenarios/calendar/calendar.scheduling-with-others.ask-preferences.scenario.ts`
- `test/scenarios/calendar/calendar.scheduling-with-others.propose-times.scenario.ts`
- `test/scenarios/calendar/calendar.dossier.prep-briefing.scenario.ts`
- `test/scenarios/calendar/calendar.calendly.navigate.scenario.ts`

### Messaging, Inbox, And Follow-Ups

- `test/scenarios/messaging.cross-platform/cross-platform.unified-inbox.scenario.ts`
- `test/scenarios/messaging.cross-platform/cross-platform.triage-priority-ranking.scenario.ts`
- `test/scenarios/messaging.cross-platform/cross-platform.same-person-multi-platform.scenario.ts`
- `test/scenarios/messaging.gmail/gmail.triage.high-priority-client.scenario.ts`
- `test/scenarios/messaging.gmail/gmail.send-with-confirmation.scenario.ts`
- `test/scenarios/messaging.gmail/gmail.draft.followup-14-days.scenario.ts`
- `test/scenarios/relationships/followup.daily-digest.scenario.ts`
- `test/scenarios/relationships/followup.track-overdue.scenario.ts`
- `test/scenarios/relationships/followup.draft-cross-platform.gmail.scenario.ts`
- `test/scenarios/relationships/followup.draft-cross-platform.discord.scenario.ts`
- `test/scenarios/relationships/followup.draft-cross-platform.telegram.scenario.ts`

### Activity, Browser, And Remote Help

- `test/scenarios/activity/activity.per-app.today.scenario.ts`
- `test/scenarios/browser.lifeops/lifeops-extension.time-tracking.per-site.scenario.ts`
- `test/scenarios/browser.lifeops/lifeops-extension.time-tracking.social-breakdown.scenario.ts`
- `test/scenarios/browser.lifeops/browser.computer-use.agent-fails-calls-user-for-help.scenario.ts`
- `test/scenarios/remote/remote.agent-calls-for-help.scenario.ts`
- `test/scenarios/remote/remote.mobile-controls-mac.scenario.ts`

### Reminders, Devices, And Escalation

- `test/scenarios/reminders/reminder.alarm.sets-macos-alarm.scenario.ts`
- `test/scenarios/reminders/reminder.alarm.sets-ios-alarm.scenario.ts`
- `test/scenarios/reminders/reminder.cross-platform.fires-on-mac-and-phone.scenario.ts`
- `test/scenarios/reminders/reminder.cross-platform.created-on-phone-fires-on-mac.scenario.ts`
- `test/scenarios/reminders/reminder.cross-platform.acknowledged-syncs.scenario.ts`
- `test/scenarios/reminders/reminder.escalation.intensity-up.scenario.ts`

### Gateway And Transport

- `test/scenarios/gateway/discord-gateway.bot-routes-to-user-agent.scenario.ts`
- `test/scenarios/gateway/telegram-gateway.bot-routes-to-user-agent.scenario.ts`
- `test/scenarios/gateway/whatsapp-gateway.bot-routes-to-user-agent.scenario.ts`
- `test/scenarios/gateway/twilio.sms.send-from-agent-with-confirmation.scenario.ts`
- `test/scenarios/gateway/twilio.call.outbound-with-confirmation.scenario.ts`
- `test/scenarios/gateway/bluebubbles.imessage.send-blue.scenario.ts`
- `test/scenarios/gateway/billing.20-percent-markup-applied.scenario.ts`

## Coverage Gaps Exposed By The Transcript

The transcript reveals composition gaps that are not yet first-class scenarios:

### 1. Calendar Defense With Relationship Context

Missing transcript-specific flows:

- recurring “time with Jill” block creation
- protecting sleep windows while still allowing intentional overrides
- keeping the calendar clear during travel or crisis periods
- bundling adjacent meetings while the user is in a city temporarily

### 2. Missed-Commitment Repair

Missing transcript-specific flows:

- user says they missed a meeting
- agent drafts apology / repair language
- agent reschedules or proposes alternate times
- agent closes the loop and confirms success

### 3. Travel Preference Capture And Reuse

The transcript shows the assistant asking once for:

- class
- seat
- bag behavior
- hotel budget
- distance tolerance
- extension preference

We need scenarios that persist these preferences and reuse them later without re-asking.

### 4. Briefs That Combine Inbox, Drafts, Calendar, Docs, And Follow-Ups

The transcript’s late-stage behavior is not “list my reminders.” It is:

- top actions
- urgent blockers
- inbox summaries by channel
- unsent drafts awaiting sign-off
- reminders with exact times

We need a scenario that seeds all of those at once and verifies composition order.

### 5. Docs And Portal Operations

Missing transcript-specific flows:

- sign this before your appointment
- upload the deck to the event portal
- send me the license copy so I can finish the workflow
- escalate before the end-of-week deadline

### 6. Travel-Day And Cancellation-Fee Escalations

Missing transcript-specific flows:

- warn the user that missing an appointment has a cancellation fee
- detect a conflict before a flight and propose rebooking
- push a travel-day itinerary with links and buffers

## New Scenario Suites To Add

These should be authored either as new scenarios or as transcript-derived overlays on existing scenarios.

Status:

- The new transcript-derived suite has been materialized under `test/scenarios/executive-assistant/`.
- The transcript-derived executive-assistant suite is now largely executable and contract-enforced rather than placeholder-only.
- Remaining placeholder debt is concentrated in older gateway, remote, browser-extension, activity, and relationship edge scenarios where the underlying platform or data-plane coverage is still incomplete.
- The runner surface is no longer the main blocker; remaining sentinels should be treated as real product gaps or deleted when newer certification or executive-assistant coverage already supersedes them.

### Suite A — Time Defense And Scheduling

New scenarios:

- `ea.schedule.daily-time-with-jill`
- `ea.schedule.protect-sleep-window`
- `ea.schedule.travel-blackout-reschedule`
- `ea.schedule.bundle-meetings-while-traveling`
- `ea.schedule.reuse-earliest-available-policy`

Related existing scenarios:

- `calendar.scheduling-with-others.ask-preferences`
- `calendar.scheduling-with-others.propose-times`
- `calendar.reschedule.conflict-detection`
- `calendar.defend-time.protects-focus`

### Suite B — Inbox Triage And Daily Briefing

New scenarios:

- `ea.inbox.daily-brief-cross-channel`
- `ea.inbox.daily-brief-includes-unsent-drafts`
- `ea.inbox.daily-brief-ranks-urgent-before-low-priority`
- `ea.inbox.ask-archive-or-respond-low-value-inbound`
- `ea.inbox.propose-group-chat-handoff`

Related existing scenarios:

- `cross-platform.unified-inbox`
- `cross-platform.triage-priority-ranking`
- `followup.daily-digest`
- `gmail.triage.high-priority-client`

### Suite C — Follow-Up Persistence

New scenarios:

- `ea.followup.bump-unanswered-decision`
- `ea.followup.repair-missed-call-and-reschedule`
- `ea.followup.offer-alternate-dates-after-no-response`
- `ea.followup.relationship-congrats-from-daily-brief`

Related existing scenarios:

- `gmail.draft.followup-14-days`
- `followup.track-overdue`
- `followup.draft-cross-platform.gmail`
- `followup.draft-cross-platform.discord`
- `followup.draft-cross-platform.telegram`

### Suite D — Travel And Event Operations

New scenarios:

- `ea.travel.capture-booking-preferences`
- `ea.travel.book-after-approval`
- `ea.travel.sync-flight-plan-into-calendar`
- `ea.travel.flight-conflict-rebooking`
- `ea.events.itinerary-brief-with-links`
- `ea.events.asset-deadline-checklist`

Related existing scenarios:

- `calendar.create.travel-time`
- `calendar.create.with-prep-buffer`
- `calendar.reminder.1hr-before`
- `calendar.reminder.10min-before`
- `calendar.reminder.on-the-dot`

### Suite E — Docs, Sign-Off, And Portals

New scenarios:

- `ea.docs.signature-before-appointment`
- `ea.docs.portal-upload-from-chat`
- `ea.docs.eow-approval-escalation`
- `ea.docs.collect-id-copy-for-workflow`

Related existing scenarios:

- no direct transcript-shaped coverage today

### Suite F — Push, Escalation, And Cross-Device Delivery

New scenarios:

- `ea.push.multi-device-meeting-ladder`
- `ea.push.cancellation-fee-warning`
- `ea.push.stuck-agent-calls-user`
- `ea.push.cross-channel-escalation-if-chat-ignored`

Related existing scenarios:

- `reminder.cross-platform.fires-on-mac-and-phone`
- `reminder.cross-platform.acknowledged-syncs`
- `reminder.escalation.intensity-up`
- `remote.agent-calls-for-help`
- `twilio.call.outbound-with-confirmation`

### Suite G — Connector Certification

Every connector named in the PRD needs explicit certification scenarios in addition to transcript-derived composition scenarios.

Required certification suites:

- Gmail: read, draft, send-after-approval, deep-link provenance, degraded auth
- Google Calendar: availability, create, reschedule, recurring block, cancel, conflict repair
- Calendly: availability handoff, booking reconciliation, browser/API fallback
- Discord: inbound fetch, reply draft, send, thread context, deep link
- Telegram: inbound fetch, reply draft, send, thread context, deep link
- X DMs: inbound fetch, reply draft, send, thread context, deep link where available
- Signal: inbound fetch, reply draft, send, delivery/degraded behavior
- WhatsApp: inbound fetch, reply draft, send, delivery/degraded behavior
- iMessage / BlueBubbles / Blooio: local-bridge health, send, delivery state, reconnect behavior
- Twilio SMS: send-after-approval, delivery state, retry/idempotency
- Twilio voice: call-after-approval, outcome state, escalation ladder integration
- Google Drive / Docs / Sheets: file fetch, upload, share, provenance, degraded auth
- Travel booking adapters: search, hold, book, sync itinerary, rebook on conflict
- Desktop / mobile notifications: dispatch, ack sync, suppression after ack
- Browser / portal bridge: upload, blocked-state intervention, credential-scoped resume

These are not optional "connector smoke tests." They are release gates for claiming a connector works inside executive-assistant mode.

## Runner Features Needed

Several transcript-derived scenarios require stronger runner support:

### 1. Cron / Background Tick Control

Need a first-class way to advance the runtime clock and trigger:

- morning briefs
- follow-up watchdogs
- reminder ladders
- deadline sweeps

Suggested primitive:

- `kind: "tick"` turn or `seed: { type: "advanceClock", by: "6h" }`

### 1b. Extraction And Action Assertions

Need a way to assert:

- which domain action the extractor selected
- which arguments were extracted
- whether the run asked for clarification instead of using a heuristic fallback
- whether a blocked connector produced an explicit intervention artifact

Suggested final checks:

- `selectedAction`
- `selectedActionArguments`
- `clarificationRequested`
- `interventionRequestExists`

### 2. Outbound Push Assertions

Need a way to assert that a scenario caused:

- desktop notification
- mobile notification
- SMS
- phone call
- outbound connector DM

Suggested final checks:

- `pushSent`
- `pushEscalationOrder`
- `pushAcknowledgedSync`

### 3. Approval Queue Assertions

Need a first-class check for:

- draft exists but not sent
- approval request is pending
- send only happens after confirm turn

Suggested final checks:

- `approvalRequestExists`
- `draftExists`
- `messageDelivered`

### 4. Browser And Portal Task Assertions

Need to assert:

- portal upload happened
- required form fields were completed
- browser automation paused and requested human help when blocked

Suggested checks:

- `browserTaskCompleted`
- `browserTaskNeedsHuman`
- `uploadedAssetExists`

### 5. Connector Capability State Seeding

Need scenario seeds for:

- connector authenticated and healthy
- connector authenticated but missing scope
- connector disconnected
- connector rate-limited
- connector capability absent on a specific provider

Suggested seed forms:

- `connectorState`
- `connectorCapabilities`
- `connectorRateLimit`
- `connectorAuthScopes`

## Priority Order

### P0

- connector certification for Gmail, Google Calendar, Twilio, desktop/mobile notifications, and browser bridge
- extraction/action assertions in the runner
- cron/background tick control
- daily brief cross-channel
- unsent draft approval loop
- travel preference capture
- flight conflict rebooking
- signature-before-appointment
- multi-device meeting ladder
- missed-call repair and reschedule

### P1

- connector certification for Discord, Telegram, Signal, WhatsApp, and iMessage bridges
- recurring Jill block
- sleep-window protection
- bundled city meetings
- itinerary brief with links
- portal upload from chat
- cancellation-fee warning

### P2

- group-chat handoff
- archive-or-respond low-value inbound
- relationship congratulations from daily brief
- collect ID copy for workflow

## Definition Of Done

This transcript is covered when the scenario matrix can prove:

1. The agent can compile an operational brief from real seeded inbox, calendar, draft, and doc state.
2. The agent can ask for the right approval, not just any approval.
3. The agent can recover from silence or missed meetings with a real follow-up loop.
4. The agent can coordinate travel and event operations without losing calendar integrity.
5. The agent can push and escalate across devices and channels when timing matters.
6. The agent can operate as one coherent executive-assistant system instead of isolated feature demos.
7. The agent chooses actions through LLM extraction and typed action calls rather than heuristic string routing.
8. Every claimed connector passes capability certification in both happy and degraded modes.
