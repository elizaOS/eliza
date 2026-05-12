# PRD: LifeOps Executive Assistant

Status: Draft  
Last updated: 2026-04-17

## Source

This PRD is grounded in a real Discord working relationship between Shaw and a human executive assistant:

- Raw export: a Discord direct-message export covering January 2025 through April 2026 (path local to the original author's workspace; not checked into the tree).
- Derived readable log: `.tmp/lifeops-research/ice-bambam-conversation-log.md`

The transcript spans **1,925 messages** from **January 1, 2025** through **April 15, 2026**. The readable log redacts inline secrets.

This is not a generic “AI assistant” spec. It is a transcript-grounded model of what a real executive assistant actually did: protect time, triage inbound, push for decisions, repair dropped balls, coordinate travel, manage docs, and keep pressure on follow-ups.

## What The Transcript Proves

The assistant workload is dominated by operational coordination, not chat:

- Scheduling and calendar coordination appear constantly.
- Follow-up nudges are a repeated loop, not a one-off feature.
- Cross-channel inbox management is core work, especially email, Telegram, X, Discord, and group chats.
- Travel and event logistics are tightly coupled to calendar management.
- Document collection, signature requests, portal uploads, and approvals are frequent.
- The assistant regularly asks for permission before acting, then executes quickly once approved.
- Later in the transcript, the assistant graduates from reactive replies into structured briefs, action digests, and daily operational summaries.

Heuristic keyword sweeps over the transcript showed roughly:

| Category | Approx. message hits |
|---|---:|
| Scheduling / calendar | 386 |
| Messaging / inbox | 169 |
| Documents / approval | 159 |
| Logistics / events | 169 |
| Reminder / follow-up nudges | 119 |
| Travel | 89 |

These counts overlap, but the shape is clear: **LifeOps needs an executive-operations core**, not just tasks and reminders.

Those sweeps were only transcript-analysis aids. They are not permission to ship runtime keyword routing, regex intent classifiers, or hardcoded semantic scoring.

## Representative Transcript Scenarios

| Date | Observed assistant behavior | Product implication |
|---|---|---|
| January 4, 2025 | Create a recurring hour each day for Jill before sleep | LifeOps needs recurring block creation plus relationship-aware time protection |
| January 7, 2025 | Ask whether a 7 AM call is allowed because of a protected sleep block | Preferences and blackout windows must be enforced, with override handling |
| January 10, 2025 | Bulk-cancel or reschedule partnership meetings because the user lost a passport and is stranded | Bulk calendar changes and repair messaging must be first-class actions |
| March 29, 2025 | Ask once for reusable flight and hotel preferences | Travel preferences must be durable profile state, not per-trip ad hoc prompts |
| May 9, 2025 | Ask the user to send a deck so it can be uploaded to a speaker portal | Browser and portal workflows must be operable from chat with approval gates |
| December 9, 2025 | Send a structured brief with urgent actions, reminders, email, and Telegram summaries | Daily brief composition must be deterministic and testable |
| January 12, 2026 | Send a daily brief that includes Telegram DMs, emails, and unsent drafts needing approval | Unified inbox and draft approval state must feed one briefing surface |
| March 4, 2026 | User admits missing a call and asks to repair it and reschedule ASAP | Repair-after-miss is a core executive-assistant workflow, not an edge case |

## Product Thesis

LifeOps should behave like a real executive assistant with memory, permissions, and reach:

1. It owns the user’s operational surface area across inbox, calendar, follow-ups, travel, docs, and reminders.
2. It is proactive by default: it notices drift, prepares briefs, asks for decisions, and escalates when silence becomes risk.
3. It is approval-aware: it drafts and proposes aggressively, but does not send sensitive or costly actions without explicit user consent.
4. It works across devices and platforms from a single agent memory, with local bridges for native capabilities and cloud transport when needed.
5. It produces durable state: every reminder, draft, follow-up, approval, booking, and escalation is inspectable and testable.

## Primary Jobs To Be Done

### 1. Defend Time

- Keep the calendar aligned with the user’s actual priorities.
- Protect sleep windows, focus blocks, travel windows, and relationship time.
- Ask before scheduling when preferences are unclear.
- Reschedule quickly when the user misses, cancels, or deprioritizes.

### 2. Triage Inbound

- Read cross-platform inbound messages and bucket them by urgency, relationship, and required response.
- Surface the highest-risk items first.
- Draft responses and ask for approval when needed.
- Track which drafts are still unsent.

### 3. Drive Follow-Through

- Keep nudging when a decision is blocking other people.
- Detect overdue follow-ups.
- Create daily or weekly digests of who needs a response.
- Repair missed commitments by apologizing, rescheduling, or clarifying.

### 4. Run Travel And Event Ops

- Capture reusable travel preferences.
- Book flights and hotels after approval.
- Keep travel-aware calendar blocks accurate.
- Generate itineraries, prep packets, event links, and asset deadlines.

### 5. Handle Docs, Signatures, And Portals

- Collect signatures before appointments or events.
- Track document deadlines and approval requests.
- Upload decks and assets to speaker portals.
- Chase down missing IDs, forms, and attachments.

### 6. Escalate Reliably

- Remind before meetings with a ladder, not a single ping.
- Warn when inaction will create a fee, missed flight, missed interview, or missed slot.
- Push across desktop, mobile, SMS, calls, and messaging channels when the situation warrants it.
- Call for help when browser or computer-use automation gets stuck.

## Product Principles

### Local-First, Bridge-Backed

The agent may run locally or in cloud, but native capabilities live on the user’s device:

- local calendar and reminders
- local browser and extension telemetry
- local iMessage / BlueBubbles / native messaging bridges
- local website and app blocking
- local credential injection and form fill

### Approval-First For External Consequences

The transcript shows a consistent human pattern: ask first, then act fast. LifeOps should preserve that:

- safe to automate inside a user-approved preference envelope
- unsafe to send, book, sign, or commit without confirmation unless explicitly delegated

### Proactive, Not Passive

The assistant should not wait for the user to ask “what did I miss?” It should already know.

### One Operational Memory

Inbox, calendar, reminders, travel, relationships, follow-up timers, approvals, and device endpoints should resolve to the same user state and contact graph.

## Non-Negotiable Execution Rules

### 1. Semantic Routing Must Be LLM-Extracted

LifeOps must not choose user intent, subaction, or urgency class by keyword lists, regex term banks, sender-name string matching, or platform-specific phrase checks.

Instead, every user request, inbound event, and cron wake-up must flow through structured extraction:

- normalize the raw event into a typed input envelope
- run LLM extraction to identify the intended domain action, missing fields, approval class, urgency, and candidate targets
- validate the extracted payload against action schemas
- execute only validated domain actions

### 2. Actions Must Be Domain Actions, Not Prompt Wishes

The model should not be asked to "just handle it" with freeform connector behavior. It must select typed actions with typed inputs and typed results.

- the action layer owns side effects
- the extractor owns semantic understanding
- the planner owns sequencing, approval checks, and retries
- connectors only implement provider capabilities

### 3. Connector Logic Must Sit Behind Capability Adapters

The product layer may know that it needs to send a message, fetch a thread, create a calendar event, upload a file, or escalate a notification. It must not branch on ad hoc connector-specific semantics to decide what the work means.

Allowed:

- capability discovery such as "this connector supports `draftMessage` and `sendMessage`"
- provider selection such as "use Gmail for email" or "use Twilio for SMS"
- endpoint-specific payload mapping inside the connector adapter

Not allowed:

- semantic routing by channel keyword
- connector-specific intent interpretation
- separate handwritten logic trees per platform for the same user intent

### 4. Background Jobs Must Use The Same Pipeline

Cron jobs, event-driven ingest, follow-up watchdogs, brief builders, and escalation ladders must use the same extraction, planning, approval, execution, and audit pipeline as live chat requests.

There cannot be one clean path for chat and a second heuristic path for background work.

### 5. Failures Must Surface Explicitly

If extraction confidence is too low, connector auth is broken, a capability is missing, or a provider call fails, the system must surface that state as an explicit assistant artifact:

- ask a clarifying question
- create an approval or intervention request
- produce a degraded-mode brief item
- trigger remote-help escalation when configured

No silent downgrade to "notify", "ignore", or "best guess" execution.

## Required Integrations And Providers

| Capability | Surface | Preferred provider(s) | Why it is required |
|---|---|---|---|
| Email triage and send | Gmail | Gmail API / Google Workspace OAuth | Transcript repeatedly references inbox review, drafts, approvals, and follow-ups |
| Calendar CRUD and scheduling | Google Calendar | Google Calendar API | Meeting creation, rescheduling, reminders, travel-aware holds |
| Meeting links and event data | Google Meet, Riverside, Zoom, other event links | Native event metadata + browser fallback | Transcript constantly moves links, interviews, podcast rooms, and call details |
| Scheduling with others | Calendly | Calendly API + browser fallback | Transcript includes direct Calendly booking links and time coordination |
| Cross-platform messaging | Discord, Telegram, X DMs, Signal, WhatsApp | Local connector APIs where possible, gateway bots where necessary | Transcript uses multiple channels as active operating surfaces |
| iMessage / SMS | BlueBubbles or Blooio, Twilio | BlueBubbles/Blooio for iMessage, Twilio for SMS/calls | Needed for push, confirmations, and mobile reach |
| Contacts / relationship memory | Rolodex / contacts graph | Internal contact graph seeded from platform data | Required for relationship-sensitive triage and follow-ups |
| Travel and booking | Airline / hotel / event sites | Browser automation first, direct APIs when available | Transcript includes frequent flight and hotel booking work |
| Docs, forms, portals | Google Docs/Sheets/Drive, event portals | Google APIs + browser automation | Signature requests, spreadsheets, uploads, and speaker portals recur |
| Activity awareness | Desktop app usage + browser extension | NSWorkspace + LifeOps browser extension | Needed for context-aware nudges, focus protection, and “what did I do today?” |
| Credential injection | 1Password, Proton Pass | Native/extension bridge with whitelist enforcement | Needed for safe browser automation and portal completion |
| Website/app blocking | SelfControl + native blockers | Existing blockers and mobile equivalents | Required for harsh-mode enforcement and focus recovery |
| Cross-device push | Desktop, mobile, SMS, calls, chat | Native notifications + Twilio + connector send paths | Needed for escalation ladders and reliable wakeups |
| Remote help handoff | Remote control / pairing | Cloud pairing + secure remote session | Needed when the agent gets stuck and the user must intervene |

Provider choice is secondary to connector contract compliance. A provider is only acceptable if it satisfies the capability contract and certification requirements below.

## Connectivity Model

LifeOps needs a three-part execution model:

### 1. Agent Runtime

- owns planning, memory, prioritization, follow-up logic, and approval state
- can run locally or in cloud
- exposes one unified operational model regardless of device

### 2. Local Bridge

- runs on the user’s Mac and phone
- exposes native capabilities, local connectors, browser extension streams, reminders, alarms, website blocking, autofill, and remote-control anchors
- syncs durable events back into the runtime

### 3. Gateway Layer

- connects cloud or local runtime to messaging transports and push transports
- supports Discord, Telegram, WhatsApp, Twilio, BlueBubbles/Blooio, and future channels
- records cost, delivery state, confirmation state, and audit history

### 4. Connector Registry And Capability Layer

- exposes each connected provider through a typed capability adapter
- reports connector health, auth state, scopes, rate-limit state, and supported operations
- resolves which concrete provider can satisfy a requested domain action
- returns durable external IDs, deep links, receipts, and reconciliation metadata

## Connector Capability Contract

Every connector must implement a typed capability surface. "Connector works" means these operations are available, observable, and testable where the provider claims support.

| Capability family | Minimum operations | Required outcome |
|---|---|---|
| Messaging read | `listThreads`, `listMessages`, `getMessage`, `getThreadContext`, `getDeepLink` | Unified inbox can ingest and cite real messages with provenance |
| Messaging write | `draftMessage`, `sendMessage`, `replyToMessage`, `createGroupThread` | Approval-gated outbound can draft first and send second |
| Calendar | `listEvents`, `findAvailability`, `createEvent`, `updateEvent`, `cancelEvent`, `getEventDeepLink` | Scheduling and repair flows can act without connector-specific prompt logic |
| Contacts / graph | `resolveContact`, `listHandles`, `upsertRelationshipSignals` | Same person can be linked across platforms and ranked correctly |
| Docs / storage | `listFiles`, `readFile`, `uploadFile`, `shareFile`, `getFileDeepLink` | Portal, signature, and asset workflows can move real artifacts |
| Browser / portal | `openTask`, `fillField`, `uploadAsset`, `submitStep`, `requestHumanHelp` | Browser automation can be planned, paused, resumed, and escalated |
| Travel / booking | `searchOptions`, `holdOption`, `bookOption`, `syncItinerary`, `rebookOption` | Travel flows can move from suggestion to approval to execution |
| Notifications | `registerEndpoint`, `dispatchNotification`, `acknowledgeNotification`, `escalateNotification` | Reminder ladders can fan out and suppress duplicates after ack |
| Telephony | `sendSms`, `placeCall`, `recordDeliveryState` | Escalation can reach the user when chat is not enough |
| Remote help | `requestRemoteAssist`, `startSession`, `recordAssistOutcome` | Stuck browser or device workflows can hand off safely |

## Cross-Platform Connectivity Rules

| Source event | Must update | Downstream effect |
|---|---|---|
| New Gmail / Discord / Telegram / X / Signal / WhatsApp message | `Thread`, `Contact`, `BriefItem`, `FollowUpPolicy` | Appears in unified inbox, daily brief, and overdue follow-up logic |
| New or changed calendar event | `ScheduleBlock`, `NotificationIntent` | Rebuild reminder ladder, prep buffer, travel buffer, and dossier state |
| Travel booking or itinerary change | `TravelPlan`, `ScheduleBlock` | Recheck conflicts, airport timing, hotel proximity, and event-day briefs |
| Draft created or edited | `DraftMessage`, `ApprovalRequest` | Appears in approval queue and daily brief until sent or rejected |
| Approval response from user | `ApprovalRequest`, target workflow object | Executes send, booking, upload, or reschedule action |
| Push acknowledgement on one device | `NotificationIntent`, `DeviceEndpoint` | Suppresses duplicate escalations on other devices when appropriate |
| Browser workflow blocked | `ApprovalRequest`, `NotificationIntent` | Triggers human-help handoff or remote-control escalation |

## Extraction And Execution Pipeline

Every LifeOps request or wake-up should follow the same pipeline:

1. `OperationalEvent` normalization.
The system converts a user message, connector inbound, cron tick, approval response, or browser callback into one typed event envelope with source metadata.

2. LLM extraction.
The model extracts:
- target domain action
- structured arguments
- missing required fields
- approval class
- urgency / risk / deadline signals
- referenced contacts, threads, docs, bookings, or calendar objects

3. Schema validation.
The extracted action payload is validated against the action schema. Invalid payloads do not execute.

4. Planning and approval.
The planner sequences actions, resolves dependencies, checks connector capability availability, and asks the user for missing information or approval when required.

5. Connector execution.
The executor calls typed action handlers. Action handlers call connector capability adapters. Provider-specific mapping stays inside the connector boundary.

6. Durable audit and follow-up.
The result updates domain state, approval state, deep links, delivery receipts, retries, and follow-up timers so future turns and cron handlers continue from real state.

## Deterministic Logic That Is Allowed

LifeOps should be LLM-first for semantics, but not nondeterministic everywhere. The following logic should remain deterministic:

- schema validation and type coercion
- approval policy enforcement
- capability discovery and provider selection
- idempotency keys and duplicate suppression
- delivery retry budgets, backoff, and ack suppression
- cost controls and send-rate controls
- safety redaction and credential-scope enforcement
- ranking tie-breaks that operate on extracted structured fields such as deadline, confidence, or explicit risk level

## Deterministic Logic That Is Not Allowed

The following patterns should be treated as architectural violations:

- keyword or regex intent routers for semantic action selection
- keyword or regex subaction routers inside a domain action
- rule strings such as `keyword:`, `sender:`, `channel:`, or `source:` to decide urgency or semantic class
- hardcoded score formulas for message importance or likely-reply-needed classification
- connector-specific branches that reinterpret the same user request differently by channel
- silent fallback from extraction failure to arbitrary default behavior

## Core Domain Objects

LifeOps needs explicit state for the work the transcript shows:

| Object | Purpose |
|---|---|
| `Contact` | Person, organization, handles, role, importance, relationship notes |
| `Thread` | Per-platform conversation with contact linkage and follow-up state |
| `DraftMessage` | Proposed outbound reply with channel, tone, approval state, and source context |
| `FollowUpPolicy` | Rules for when a person or thread becomes overdue |
| `CalendarPreference` | Preferred meeting times, blackout windows, sleep windows, focus rules |
| `ScheduleBlock` | Internal hold, meeting, buffer, travel block, or decompression block |
| `TravelPreference` | Flight, hotel, luggage, seat, arrival, proximity, and extension preferences |
| `TravelPlan` | Actual itinerary with booking state, approval state, and linked events |
| `EventOpportunity` | Invite, talk, interview, panel, meetup, dinner, hackathon, judging request |
| `DocumentRequest` | Something that needs signature, review, upload, or approval by a deadline |
| `ApprovalRequest` | A queued decision with consequence class and expiration |
| `BriefItem` | A ranked item that can appear in a daily brief or push digest |
| `NotificationIntent` | A reminder or escalation targeted to desktop, mobile, SMS, call, or chat |
| `DeviceEndpoint` | Registered desktop/mobile/chat delivery target with ack state |

## Action Catalog

The transcript implies a concrete action surface. These actions should be real first-class actions, not prompt-only wishes.

These are domain actions. Connector-facing provider operations should live below this catalog behind capability adapters.

### Calendar And Scheduling

- `CALENDAR_LIST_UPCOMING`
- `CALENDAR_FIND_AVAILABILITY`
- `CALENDAR_CREATE_EVENT`
- `CALENDAR_CREATE_RECURRING_BLOCK`
- `CALENDAR_RESCHEDULE_EVENT`
- `CALENDAR_CANCEL_EVENT`
- `CALENDAR_PROPOSE_TIMES`
- `CALENDAR_PROTECT_WINDOW`
- `CALENDAR_BUNDLE_MEETINGS`
- `CALENDAR_ADD_PREP_BUFFER`
- `CALENDAR_ADD_TRAVEL_BUFFER`
- `CALENDAR_BUILD_DOSSIER`

### Inbox And Messaging

- `INBOX_LIST_UNREAD`
- `INBOX_TRIAGE_PRIORITY`
- `INBOX_SUMMARIZE_CHANNEL`
- `MESSAGE_DRAFT_REPLY`
- `MESSAGE_SEND_APPROVAL_REQUEST`
- `MESSAGE_SEND_CONFIRMED`
- `MESSAGE_ARCHIVE_OR_DEFER`
- `MESSAGE_CREATE_GROUP_HANDOFF`
- `MESSAGE_REPAIR_AFTER_MISS`
- `THREAD_LINK_CONTACT`

### Follow-Ups

- `FOLLOWUP_CREATE_RULE`
- `FOLLOWUP_LIST_OVERDUE`
- `FOLLOWUP_CREATE_DRAFT`
- `FOLLOWUP_SEND_CONFIRMED`
- `FOLLOWUP_GENERATE_DIGEST`
- `FOLLOWUP_ESCALATE`

### Travel And Events

- `TRAVEL_CAPTURE_PREFERENCES`
- `TRAVEL_BOOK_FLIGHT`
- `TRAVEL_BOOK_HOTEL`
- `TRAVEL_SYNC_ITINERARY_TO_CALENDAR`
- `TRAVEL_REBOOK_AFTER_CONFLICT`
- `EVENT_CREATE_OPPORTUNITY`
- `EVENT_SET_DECISION_DEADLINE`
- `EVENT_BUILD_ITINERARY_BRIEF`
- `EVENT_TRACK_ASSET_DEADLINES`

### Docs And Portals

- `DOC_REQUEST_SIGNATURE`
- `DOC_REQUEST_APPROVAL`
- `DOC_TRACK_DEADLINE`
- `DOC_UPLOAD_ASSET`
- `DOC_COLLECT_ID_OR_FORM`
- `DOC_CLOSE_REQUEST`

### Push And Escalation

- `NOTIFICATION_CREATE_INTENT`
- `NOTIFICATION_RESOLVE_ENDPOINTS`
- `NOTIFICATION_DISPATCH`
- `NOTIFICATION_ACKNOWLEDGE`
- `NOTIFICATION_ESCALATE`
- `REMOTE_REQUEST_HELP`

## Background Jobs And Cron Handlers

This product cannot be fully user-message-driven. The transcript shows the assistant constantly revisiting stale work. LifeOps needs background handlers.

| Job | Cadence | Purpose |
|---|---|---|
| Inbox ingest per connector | event-driven + polling fallback | Pull new messages into unified inbox |
| Daily brief builder | morning local time | Build ranked digest across inbox, calendar, drafts, follow-ups, docs |
| Evening closeout | evening local time | Surface unresolved decisions, tomorrow’s commitments, and required prep |
| Follow-up watchdog | daily | Mark contacts/threads as overdue and create draft nudges |
| Decision nudger | every few hours on active approvals | Re-ask when the user has not decided on scheduling, travel, or docs |
| Meeting reminder ladder | 1h, 10m, at-time | Multi-device reminders with ack sync |
| Travel conflict detector | on itinerary change + nightly sweep | Detect flights, missed buffers, and calendar overlaps |
| Event asset sweeper | daily near event dates | Chase slides, bios, forms, and approvals |
| Draft aging sweeper | daily | Surface drafts that still need approval or sending |
| Remote stuck-agent escalator | on browser/computer-use failure | Trigger call, SMS, or remote-control handoff |

## Follow-Up Handlers

These handlers should exist explicitly in the system, because the transcript uses them repeatedly:

| Handler | Trigger | Output |
|---|---|---|
| `pending-decision-nudger` | User has not answered a blocking scheduling or travel question | Reminder in chat or brief with preserved context |
| `missed-commitment-repair` | User says they missed a meeting or reply window | Draft apology, propose alternatives, update calendar or follow-up state |
| `unsent-draft-resurfacer` | Draft exists without approval past threshold | Daily brief item and optional push reminder |
| `relationship-overdue-detector` | Contact has crossed follow-up threshold | Ranked follow-up task and draft suggestion |
| `deadline-escalator` | Appointment, fee, or docs deadline is near | Stronger push ladder and explicit risk framing |
| `travel-ops-rechecker` | Itinerary or event timing changes | Updated buffers, brief, and booking/rebooking suggestions |

## Approval Model

| Action class | Default policy |
|---|---|
| Read inbox, summarize, prioritize, draft | autonomous |
| Create internal holds inside a known preference envelope | autonomous |
| Accept or decline new external meeting | ask first |
| Send outbound message as the user | ask first |
| Book flight, hotel, dinner, or anything with cost | ask first |
| Upload sensitive document or ID | ask first |
| Join or create group chats involving external people | ask first |
| Trigger SMS, call, or cross-channel push escalation | user-configurable; default ask first |
| Invoke browser or remote session with credential use | ask first unless explicitly delegated |

## Connector Certification And Acceptance

No connector should be considered "supported" for LifeOps until it passes certification at the capability level.

Each supported connector must prove:

1. Auth and health are inspectable.
The runtime can tell whether the connector is authenticated, what scopes it has, and whether it is degraded or rate-limited.

2. Read paths are real.
The connector can fetch real objects with stable external IDs, timestamps, deep links, and enough context to build briefs and follow-ups.

3. Write paths are approval-safe.
The connector can draft, stage, send, update, or cancel through the same approval model the PRD defines.

4. Receipts are durable.
The system can record whether a message, notification, booking, or upload actually happened and reconcile the result later.

5. Errors are explicit.
Missing auth, missing capability, provider errors, and rate limits surface as actionable assistant state rather than swallowed logs or silent fallback behavior.

6. Idempotency holds.
Retries do not create duplicate sends, duplicate events, duplicate uploads, or duplicate escalations.

7. Scenario coverage exists.
Every connector has at least:
- happy-path read coverage
- happy-path write coverage
- approval-gated write coverage
- degraded-auth coverage
- capability-missing coverage
- duplicate / retry coverage
- deep-link / provenance coverage

## Connector Acceptance Matrix

The minimum certification target for the first LifeOps release is:

| Connector | Required certified capabilities |
|---|---|
| Gmail | messaging read, messaging write, drafts, deep links, approval-gated send |
| Google Calendar | calendar CRUD, availability, recurring blocks, reschedule, cancel, deep links |
| Calendly | link discovery, booking metadata ingest, browser/API booking handoff, reconciliation back to calendar |
| Discord | messaging read, messaging write, thread context, deep links |
| Telegram | messaging read, messaging write, thread context, deep links |
| X DMs | messaging read, messaging write, thread context, deep links where available |
| Signal | messaging read, messaging write, receipts where available |
| WhatsApp | messaging read, messaging write, receipts where available |
| iMessage / BlueBubbles / Blooio | messaging write, thread fetch, delivery state, local bridge health |
| Twilio SMS | telephony send, delivery state, approval-gated escalation |
| Twilio voice | outbound call initiation, call outcome state, approval-gated escalation |
| Google Drive / Docs / Sheets | file read, upload, share, provenance links, approval-safe doc workflows |
| Travel booking adapter | search, hold, approve, book, itinerary sync, rebook after conflict |
| Browser / portal bridge | upload, form fill, blocked-state handoff, credential-scoped execution |
| Desktop / mobile notification bridge | notification dispatch, ack sync, escalation ladder suppression |

## User Experience Requirements

### Unified Operational Chat

The user should be able to say:

- “what do i need to handle today?”
- “book a follow-up with him next week”
- “repair that missed call and apologize”
- “what emails still need my sign-off?”
- “send that if it looks good”
- “what are my travel plans?”

And the agent should already have the right context.

### Structured Briefs

The transcript shows a mature assistant rhythm where the assistant sends concise operational briefs with:

- actions first
- reminders second
- inbox/channel summaries third
- drafts pending approval
- urgency clearly labeled

LifeOps should support this as a first-class output mode, not prompt luck.

### Persistent Follow-Up

Silence is meaningful. If the user does not answer a question that blocks others, the agent needs to come back at the right time with context, not restart from scratch.

### Cross-Device Delivery

Meeting and deadline reminders must work across:

- desktop notifications
- mobile notifications
- chat surfaces
- SMS or phone escalation when configured

## Current Repo Alignment

This repo already contains major pieces of the target surface:

- calendar scenario surfaces for scheduling, conflicts, buffers, Calendly, travel time, and dossiers
- messaging scenario surfaces for Gmail, Discord, Telegram, Signal, iMessage, WhatsApp, X, and unified inbox behavior
- relationship and follow-up scenario surfaces
- reminder and cross-device alarm scenario surfaces
- activity, browser extension, autofill, SelfControl, and remote-control scenario surfaces
- gateway scenarios for Twilio, BlueBubbles, Discord, Telegram, WhatsApp, and cloud billing markup

What is still missing is the **executive-assistant composition layer**: the exact orchestration patterns shown in the transcript where inbox, calendar, travel, docs, approvals, follow-ups, and push ladders all work together as one operating loop.

The current implementation also appears to retain several pre-PRD patterns that should be removed as the product moves toward this architecture:

- keyword and phrase matching to choose semantic actions or subactions
- rule-string overrides for inbox urgency and ignore logic
- hand-authored message-priority scoring formulas
- channel-branch execution logic above the connector capability boundary

Those shortcuts may have helped bootstrap features, but they are not compatible with the target assistant architecture.

## Implementation Sequence

The cleanest path to this architecture is:

1. Standardize extraction contracts.
Define typed extractor outputs for LifeOps domains such as inbox, calendar, travel, docs, follow-up, and notification planning. Extraction should return action name, arguments, confidence, missing fields, approval class, and referenced entities.

2. Remove semantic heuristic routers.
Delete keyword, regex, sender-rule, and score-formula routing from the action layer. If deterministic logic remains, it should operate on validated structured fields rather than raw text.

3. Introduce the connector capability registry.
Move provider checks and connector branching behind typed adapters so domain actions call capabilities instead of concrete channel codepaths.

4. Unify background execution.
Make cron jobs, connector ingests, reminder ladders, and approval follow-ups go through the same extraction, planning, and action pipeline used for user chat.

5. Add connector certification suites.
Before expanding assistant composition, make each connector pass happy-path and degraded-path capability tests so orchestration failures are not confused with connector failures.

6. Compose executive-assistant workflows.
Build the transcript-derived loops on top of the cleaned action and connector substrate: daily briefing, missed-commitment repair, travel conflict repair, doc deadline escalation, and cross-device reminder ladders.

## Definition Of Done

LifeOps can be called a real executive assistant when it can:

1. Generate a morning or daily brief from real inbox, calendar, draft, follow-up, and event state.
2. Triage inbound across multiple channels and rank urgency correctly.
3. Draft replies and send them only after the right approval step.
4. Schedule, reschedule, and defend time using remembered preferences.
5. Handle travel and event logistics with approval-gated booking and itinerary updates.
6. Track document approvals and signature deadlines.
7. Escalate missed or urgent items across multiple push surfaces.
8. Maintain relationship memory and overdue follow-up tracking.
9. Operate coherently from both desktop and mobile against one shared agent state.
10. Route semantics through LLM extraction plus typed action execution, not keyword or regex matching.
11. Execute background jobs, cron handlers, and connector ingests through the same planner and action pipeline as chat.
12. Certify every supported connector against its required capability matrix before claiming end-to-end support.
