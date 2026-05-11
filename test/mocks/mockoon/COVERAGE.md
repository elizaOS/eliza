# Mockoon coverage for lifeops scenarios

When `LIFEOPS_USE_MOCKOON=1` (the default in `bun run lifeops:full` once
W1-5 wires it through), the 18 Mockoon environments below auto-start via
`scripts/lifeops-mockoon-bootstrap.mjs` and connector base URLs are rewritten
to `http://127.0.0.1:<port>` by
`plugins/app-lifeops/src/lifeops/connectors/mockoon-redirect.ts:applyMockoonEnvOverrides()`.

This file maps environments to the scenarios that exercise them today, and
calls out gaps where a scenario *should* hit Mockoon but currently uses an
inline seed instead.

For per-connector endpoint inventories, base URLs, and env-var overrides see
`INVENTORY.md` next to this file.

## Environments

| Env             | Port  | Mocks                                                                                     | Used by scenarios |
| --------------- | ----: | ----------------------------------------------------------------------------------------- | ----------------- |
| gmail           | 18801 | Gmail API v1 (messages list/get/send, drafts, threads, labels, modify)                    | `lifeops.inbox-triage/inbox-triage.thread-with-draft`, `lifeops.morning-brief/morning-brief.urgent-mid-brief`, `lifeops.security/security.prompt-injection-inbox`, plus every scenario under `test/scenarios/messaging.gmail/` (15 scenarios) and the gmail-touching scenarios in `test/scenarios/executive-assistant/` |
| calendar        | 18802 | Google Calendar v3 (calendarList, events list/get/insert/patch/delete)                    | `lifeops.calendar/calendar.reschedule.dst-fall-back`, `lifeops.planner/planner.tool-search-empty`, `lifeops.planner/planner.tool-search-wrong`, `lifeops.workflow-events/workflow.event.calendar-ended.*` (3 scenarios), plus `test/scenarios/calendar/` (14 scenarios). **W2-1 additions** (40 new lifeops.* scenarios — Wave-2): full `test/scenarios/lifeops.calendar/` (20 new + 1 existing), full `test/scenarios/lifeops.scheduling/` (12 new), full `test/scenarios/lifeops.travel-buffer/` (8 new). |
| slack           | 18803 | Slack Web API (chat.postMessage, conversations.list/history, users.list, reactions.add)   | reserved for future slack connector tests; no lifeops.* scenario hits slack today |
| discord         | 18804 | Discord REST v10 (guilds, channels, messages list/post)                                   | `test/scenarios/messaging.discord-local/` (3 scenarios), `test/scenarios/gateway/discord-gateway.bot-routes-to-user-agent`, several `lifeops.hygiene/*` scenarios that exercise the discord room (shower-weekly, shave-weekly-formal-tone, water-default-frequency, vitamins-with-breakfast) |
| telegram        | 18805 | Telegram Bot API (sendMessage, getUpdates, getMe, sendChatAction)                         | every `lifeops.habits/*` scenario (18 total: 6 original + 12 W2-3 extensions), most `lifeops.hygiene/*` scenarios (W2-3, 22 of 27 use the telegram room), most `lifeops.sleep/*` extensions and all `lifeops.health/*` scenarios (W2-3), `lifeops.morning-brief/morning-brief.urgent-mid-brief`, `lifeops.reminders/reminders.apple-permission-denied`, `test/scenarios/messaging.telegram-local/` (3 scenarios) |
| github          | 18806 | GitHub REST (search/issues, repos/issues, repos/pulls, repos/commits)                     | reserved for future github connector tests; no lifeops.* scenario hits github today |
| notion          | 18807 | Notion API v1 (search, pages create, blocks children, databases get)                      | reserved for future notion connector tests; no lifeops.* scenario hits notion today |
| twilio          | 18808 | Twilio Programmable Messaging + Voice (`Messages.json`, `Calls.json`)                     | `test/scenarios/gateway/twilio.*` (3 scenarios) |
| plaid           | 18809 | Plaid via Eliza Cloud relay (`/v1/eliza/plaid/link-token`, `exchange`, `sync`)            | `lifeops.payments/payments.plaid-mfa-fail`, `test/scenarios/payments/` (2 scenarios) |
| apple-reminders | 18810 | Local reminders bridge (lists, reminders CRUD)                                            | `lifeops.reminders/reminders.apple-permission-denied`, `test/scenarios/reminders/` apple-touching cases |
| bluebubbles     | 18811 | BlueBubbles server REST (chat, message text send)                                         | `test/scenarios/gateway/bluebubbles.*` (2 scenarios), iMessage scenarios under `test/scenarios/messaging.imessage/`, W2-3 `lifeops.habits/habits.cross-platform-habit-via-imessage` |
| ntfy            | 18812 | `POST /{topic}` publish                                                                   | indirect — any scenario that exercises `notifications-push.ts` |
| duffel          | 18813 | Duffel air search (offer_requests, offers, orders)                                        | reserved; no lifeops.* scenario hits duffel today |
| anthropic       | 18814 | Anthropic Messages API — failure-injection only (429/529/500 via fault toggles)           | `lifeops.planner/planner.action-timeout`, `lifeops.planner/planner.invalid-json-retry` (when ANTHROPIC_BASE_URL points here) |
| cerebras        | 18815 | OpenAI-compatible chat.completions + embeddings (Cerebras deployment)                     | every scenario uses this through `OPENAI_BASE_URL` when LIFEOPS_USE_MOCKOON=1 and Cerebras is the planner/eval model |
| eliza-cloud     | 18816 | Eliza Cloud relay (auth/token, agents/me, billing/balance, plaid/paypal/schedule mirrors) | `test/scenarios/gateway/billing.*`, any scenario using cloud-managed clients |
| spotify         | 18817 | Spotify Web API (`/v1/me`, `/v1/me/player/currently-playing`)                             | reserved for future spotify connector tests |
| signal          | 18818 | signal-cli REST (`/v1/receive/{account}`, `/v2/send`)                                     | `lifeops.morning-brief/morning-brief.empty-inbox`, `lifeops.planner/planner.action-timeout`, `lifeops.reminders/reminders.apple-permission-denied`, `lifeops.sleep/sleep.apple-vs-oura-conflict`, `test/scenarios/messaging.signal/` (2 scenarios) |

## W2-1 calendar/scheduling/travel-buffer additions (Wave-2)

The 40 new lifeops scenarios authored in Wave-2 all declare `mockoon: ["calendar"]`
(some additionally reference `gmail`) so the unified `bun run lifeops:full` boot
will spawn the calendar env automatically. Wave-3 follow-up: enrich the
calendar Mockoon environment with attendee-side free/busy responses so
`scheduling.find-mutual-slots-across-attendees` can validate against real
data, and add a maps connector mock so
`travel-buffer.commute-time-from-google-maps` can assert a >=30-min buffer
from an SF→Palo Alto query rather than relying on the LLM judge.

Lifeops.calendar new scenarios (20):
- calendar.dst-spring-forward
- calendar.dst-boundary-event-series
- calendar.all-day-event-collision
- calendar.cross-tz-attendee
- calendar.shared-calendar-permission-denied
- calendar.recurr-relationship-block
- calendar.sleep-window-defense
- calendar.bundle-city-meetings
- calendar.travel-blackout-reschedule
- calendar.find-free-60min-this-week
- calendar.propose-times-respect-prefs
- calendar.check-availability-thursday-morning
- calendar.cancel-tentative-launch-checklist
- calendar.reschedule-roadmap-sync-to-afternoon
- calendar.delete-1on1-correctly
- calendar.protect-deep-work-block
- calendar.add-prep-buffer-before-1on1
- calendar.dossier-for-tomorrow-9am
- calendar.bulk-reschedule-rollback-on-error
- calendar.multi-account-selection

Lifeops.scheduling new scenarios (12):
- scheduling.propose-3-options-for-1hr
- scheduling.propose-times-with-attendees
- scheduling.attendee-counter-proposes
- scheduling.propose-respects-blackouts
- scheduling.propose-honors-buffer-prefs
- scheduling.confirm-time-creates-event
- scheduling.reject-all-proposals-asks-clarify
- scheduling.calendly-link-generation
- scheduling.find-mutual-slots-across-attendees
- scheduling.timezone-respectful-proposal
- scheduling.weekend-availability-toggle
- scheduling.preference-storage-survives-restart

Lifeops.travel-buffer new scenarios (8):
- travel-buffer.auto-add-15min-before-offsite
- travel-buffer.skip-when-back-to-back-same-location
- travel-buffer.respects-user-default
- travel-buffer.commute-time-from-google-maps (Wave-3: needs maps mock)
- travel-buffer.late-night-skips-buffer
- travel-buffer.zoom-meeting-no-buffer
- travel-buffer.cross-city-flight-buffer
- travel-buffer.adjacent-meeting-prep-vs-travel-distinguish

## W2-3 hygiene/habits/sleep/health additions (Wave-2)

The 57 new scenarios authored in Wave-2 by W2-3 cover hygiene (new domain),
habit extensions, sleep extensions, and health (new domain). All scenarios
default to the telegram room (`source: "telegram"`) unless otherwise noted,
which means they exercise the telegram Mockoon env when
`LIFEOPS_USE_MOCKOON=1`. Health scenarios additionally hit `eliza-cloud` once
the HEALTH action wires up the cloud passthrough; today they exercise
runtime-local data and the telegram surface.

Lifeops.hygiene new scenarios (27 — NEW domain):
- hygiene.brush-teeth-twice-daily
- hygiene.brush-teeth-bedtime-wakeup
- hygiene.brush-teeth-streak-recovery
- hygiene.brush-teeth-cancel-with-reason
- hygiene.brush-teeth-night-owl-schedule
- hygiene.floss-daily-before-brush
- hygiene.floss-missed-2-nights-escalate
- hygiene.shower-weekly
- hygiene.shower-daily-morning
- hygiene.shave-weekly-formal-tone
- hygiene.hair-wash-twice-weekly
- hygiene.haircut-every-6-weeks
- hygiene.skincare-am-pm-routine
- hygiene.sunscreen-daily-with-weather-context
- hygiene.lip-balm-cold-weather
- hygiene.moisturizer-after-shower
- hygiene.medication-single-daily-am
- hygiene.medication-am-pm-with-meals
- hygiene.medication-missed-dose-escalate
- hygiene.medication-conflicts-with-meal-time
- hygiene.medication-refill-reminder-2-weeks-out
- hygiene.water-default-frequency
- hygiene.water-custom-cadence-with-meals
- hygiene.vitamins-with-breakfast
- hygiene.stretch-breaks-every-90min
- hygiene.posture-check-during-deep-work
- hygiene.eye-break-20-20-20

Lifeops.habits new scenarios (12 — extensions):
- habits.holiday-skip-cadence
- habits.dst-cross-streak-integrity
- habits.week-spanning-behavior
- habits.partial-pause-only-some-habits
- habits.post-travel-resume
- habits.timezone-drift-during-travel
- habits.broken-streak-with-exception
- habits.fitness-streak-target-counts
- habits.weekend-vs-weekday-cadence
- habits.cross-platform-habit-via-imessage (uses bluebubbles room)
- habits.morning-routine-stack-3-habits
- habits.evening-wind-down-stack

Lifeops.sleep new scenarios (8 — extensions):
- sleep.nap-night-disambiguation (uses dashboard room)
- sleep.late-night-vs-schedule-conflict (also hits calendar Mockoon)
- sleep.sleep-window-protection-enforcement
- sleep.health-goal-grounding-weekly-review
- sleep.bedtime-reminder-90min-before
- sleep.wake-up-alarm-cascade
- sleep.oura-vs-apple-conflict-trust-policy (uses dashboard room)
- sleep.travel-jet-lag-adjustment

Lifeops.health new scenarios (10 — NEW domain):
- health.today-overview-walk-run-strain
- health.weekly-step-trend
- health.workout-completion-streak
- health.heart-rate-spike-alert
- health.recovery-low-suggest-rest
- health.weight-trend-7-day-avg
- health.exercise-goal-progress-mid-week
- health.medication-adherence-percentage
- health.no-data-degrade-gracefully
- health.multiple-sources-no-conflict-merge

Follow-ups (Wave-3): the health/sleep scenarios currently exercise the
runtime's local life_health_sleep_episodes / health tables via direct SQL
seeds. Once the eliza-cloud passthrough for health data is wired up, swap
to `mockoon: ["eliza-cloud"]` so the scenarios validate against the
hosted-API path the production agent actually uses. Hygiene scenarios that
exercise ntfy/twilio escalation (medication-missed-dose-escalate,
floss-missed-2-nights-escalate, brush-teeth-streak-recovery) should be
extended to assert on connector dispatches once the escalation channels
are wired through Mockoon ports 18808 (twilio) and 18812 (ntfy).

## Scenarios with no Mockoon usage today (gaps)

These lifeops.* scenarios do not reference any Mockoon-backed connector by
keyword today. Most use an inline seed or an in-memory fake. Wave-2 follow-up:

- `lifeops.controls/lifeops.device-intent.broadcast-reminder` — should hit
  `ntfy` (push) + `signal`/`telegram` (broadcast).
- `lifeops.controls/lifeops.pause.vacation-window` — should hit `calendar`
  (vacation window source of truth).
- `lifeops.documents/documents.ocr-fail` — should hit `eliza-cloud`
  (documents API is a cloud surface).
- `lifeops.planner/planner.invalid-json-retry` — uses inline planner stub;
  should swap to `anthropic` (port 18814) failure-injection toggle for the
  retry-loop regression case.

The non-lifeops trees that still need a Mockoon pass (out of scope for W1-4,
recorded so we don't lose it):

- `test/scenarios/relationships/` — `gmail`/`telegram`/`discord` follow-up
  drafts can ride the existing envs.
- `test/scenarios/todos/` — uses an in-memory store; no external surface, so
  no Mockoon hookup needed.
- `test/scenarios/connector-certification/` — by design exercises each
  connector against the matching Mockoon env; already wired through the
  certification harness.

## W2-4 travel/followup/identity/push additions (Wave-2)

The 55 new scenarios authored in Wave-2 by W2-4 cover four NEW lifeops
domains (travel, followup, identity, push). They exercise multiple Mockoon
envs via the action surfaces involved (BOOK_TRAVEL → duffel + eliza-cloud,
DEVICE_INTENT → ntfy, VOICE_CALL / SMS → twilio, identity reads → gmail +
telegram + signal + discord). All use inline seeds for the entity state,
which means the assertions exercise the agent's read/write/escalation paths
without requiring round-trips to a third-party API.

Per-env additions (cross-cutting; each scenario can touch several):

- duffel (18813): every `lifeops.travel/travel.book-*`, `travel.flight-*`,
  `travel.duffel-cloud-relay`, `travel.partial-day-trip-no-hotel`,
  `travel.upgrade-offer-flagged-for-approval`, `travel.layover-too-tight-warning`
- eliza-cloud (18816): `travel.duffel-cloud-relay` exercises the cloud-mediated
  relay path explicitly; the rest of the BOOK_TRAVEL family rides the same route
- calendar (18802): `travel.cancel-trip-rollback-events`,
  `travel.travel-blackout-defends-no-booking-during-focus`,
  `travel.cross-tz-itinerary-formatting`, plus push scenarios that tie reminders
  to calendar events (`push.meeting-reminder-T-*`, `push.full-ladder-*`,
  `push.scheduled-notification-cancel-when-event-cancelled`)
- twilio (18808): `followup.escalate-to-voice-call`,
  `push.stuck-agent-calls-user-CAPTCHA`, `push.stuck-agent-falls-back-to-SMS`,
  `push.cancellation-fee-warning-before-skip`, `push.voice-call-as-last-resort`,
  `push.signature-deadline-SMS-4h-before-appointment`,
  `push.cross-channel-escalation-if-chat-ignored`,
  `push.failed-delivery-retry-on-secondary-channel`,
  `push.urgent-bypasses-do-not-disturb`
- ntfy (18812): `push.ntfy-delivery-receipt`, plus indirect coverage from any
  DEVICE_INTENT scenario in the push directory
- gmail (18801), telegram (18805), signal (18818), discord (18804): identity
  merge / search / impersonation / rename scenarios consume handles across all
  four platforms (`identity.merge-2-platforms-same-person`,
  `identity.merge-4-platforms-same-person`, `identity.detect-likely-rename`,
  `identity.detect-impersonation-attempt`, `identity.search-across-handles`,
  `identity.merge-after-handle-rename`, `identity.unmerge-conflict-detected`,
  `identity.set-relationship-mom-priority`, `identity.tag-entity-as-VIP`,
  `identity.list-relationships-by-tag`)

Lifeops.travel new scenarios (15 — NEW domain):
- travel.book-flight-after-approval
- travel.book-hotel-with-loyalty-number
- travel.capture-preferences-first-time
- travel.flight-conflict-rebook
- travel.itinerary-brief-with-links
- travel.asset-deadline-checklist
- travel.duffel-cloud-relay
- travel.cross-tz-itinerary-formatting
- travel.cancel-trip-rollback-events
- travel.partial-day-trip-no-hotel
- travel.recurring-business-trip-template
- travel.travel-blackout-defends-no-booking-during-focus
- travel.upgrade-offer-flagged-for-approval
- travel.passport-expiry-warning
- travel.layover-too-tight-warning

Lifeops.followup new scenarios (12 — NEW domain):
- followup.bump-unanswered-decision-2-days
- followup.repair-missed-call
- followup.offer-alternates-after-no-response
- followup.relationship-congratulations-from-brief
- followup.set-cadence-quarterly
- followup.list-overdue-by-priority
- followup.followup-becomes-task
- followup.dismiss-with-reason
- followup.escalate-to-voice-call
- followup.cross-channel-followup-via-platform-of-origin
- followup.relationship-overdue-3-month-cadence
- followup.snooze-until-monday

Lifeops.identity new scenarios (10 — NEW domain):
- identity.merge-2-platforms-same-person
- identity.merge-4-platforms-same-person
- identity.detect-likely-rename
- identity.unmerge-conflict-detected
- identity.set-relationship-mom-priority
- identity.tag-entity-as-VIP
- identity.merge-after-handle-rename
- identity.detect-impersonation-attempt
- identity.search-across-handles
- identity.list-relationships-by-tag

Lifeops.push new scenarios (18 — NEW domain):
- push.meeting-reminder-T-1h
- push.meeting-reminder-T-10m
- push.meeting-reminder-T-0
- push.full-ladder-T-1h-10m-0
- push.cancellation-fee-warning-before-skip
- push.signature-deadline-SMS-4h-before-appointment
- push.stuck-agent-calls-user-CAPTCHA
- push.stuck-agent-falls-back-to-SMS
- push.cross-channel-escalation-if-chat-ignored
- push.ack-from-one-device-clears-others
- push.silent-during-deep-work
- push.urgent-bypasses-do-not-disturb
- push.partial-ack-from-mobile-keeps-desktop
- push.failed-delivery-retry-on-secondary-channel
- push.voice-call-as-last-resort
- push.ntfy-delivery-receipt
- push.scheduled-notification-cancel-when-event-cancelled
- push.batch-low-urgency-into-digest

Wave-3 follow-up:
- Add fault toggles in the duffel Mockoon env so `travel.layover-too-tight-warning`
  and `travel.passport-expiry-warning` can verify a real declined-search response.
- Wire the eliza-cloud mock with a Duffel-relay endpoint that returns deterministic
  offer payloads so `travel.duffel-cloud-relay` validates against fixture data
  rather than relying on the LLM judge.
- Extend the twilio mock with a voicemail outcome toggle so
  `push.stuck-agent-falls-back-to-SMS` can chain the call-fails → SMS-fires
  sequence end-to-end without an inline seed.

## How to run

The benchmark runner spawns the Mockoon fleet automatically when
`LIFEOPS_USE_MOCKOON=1` is set (default):

```sh
bun run lifeops:full
```

Opt out for a real-API smoke run when investigating a connector regression:

```sh
LIFEOPS_USE_MOCKOON=0 bun run lifeops:full
```

Manual lifecycle (useful when iterating on a single mock environment):

```sh
node scripts/lifeops-mockoon-bootstrap.mjs --start    # spawn fleet, return
node scripts/lifeops-mockoon-bootstrap.mjs --status   # which ports are UP
node scripts/lifeops-mockoon-bootstrap.mjs --stop     # tear everything down
```

Self-test (verifies bootstrap + redirect helper + gmail loopback path end to
end, including the `X-Mockoon-Fault: rate_limit` toggle):

```sh
node scripts/lifeops-mockoon-smoke.mjs
```

## Prerequisite: mockoon-cli

The bootstrap script resolves the Mockoon binary in this order:

1. `$MOCKOON_BIN` if it points at an existing file.
2. `mockoon-cli` on `$PATH`.
3. A repo-local npx cache at
   `~/.npm/_npx/dcd5374e2bba9184/node_modules/.bin/mockoon-cli` (populated by
   any prior `npx @mockoon/cli@latest`).
4. `npx --yes @mockoon/cli@latest` (slow cold start — adds ~30s per env).

Recommended one-time install:

```sh
npm i -g @mockoon/cli@latest
```

…or just let step 4 run once so the npx cache populates.

## How to add a Mockoon env

1. Drop a new `<service>.json` under this directory with a unique top-level
   numeric `port` field. Reuse the 18801–18820 range (avoiding the dev-server
   ports listed in `CLAUDE.md`).
2. Add route handlers for the endpoints the consumer code actually calls.
   Include the three standard fault rules (header `X-Mockoon-Fault: rate_limit`
   → 429, `auth_expired` → 401, `server_error` → 500). The other envs in this
   directory are the templates.
3. Add an entry to `applyMockoonEnvOverrides()` in
   `plugins/app-lifeops/src/lifeops/connectors/mockoon-redirect.ts` for the
   relevant env var or expose a `getMockoonBaseUrl(<connector>)` lookup.
4. Append a row to the table above and to `INVENTORY.md`.
5. Extend `scripts/lifeops-mockoon-smoke.mjs` if the new env covers a path
   that benchmark scenarios depend on.
