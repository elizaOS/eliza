# Action manifest gaps observed during corpus authoring (2026-05-10)

This file records LifeOps capabilities I wished existed in the action
manifest while authoring the Wave 2A static corpus, so the gap-analysis
agent (Wave 4C) can evaluate whether to add them.

## Mail / messaging

- **No dedicated `MAIL_DRAFT_REPLY` or `MAIL_LABEL_ADD` action.** Mail
  routes through the multi-purpose `MESSAGE` action with
  `operation: "draft_reply"` and `manageOperation: "label_add"`. This
  works but pushes mail-specific semantics into a generic action and
  forces the agent to remember the discriminator dance.
- **No `MAIL_BULK_ARCHIVE_BY_LABEL`.** Triage scenarios that should
  archive every newsletter in one shot can only loop over individual
  threads.

## Calendar

- **No `CALENDAR_FIND_RECURRING_INSTANCE`.** When the user wants to
  cancel "the recurring 4pm Tuesday standup just for next week", the
  agent must read the event, compute the right occurrence, and emit
  a delete with a recurrence-instance id — none of the manifest actions
  expose that as a single verb.
- **No `CALENDAR_LIST_BY_CALENDAR_ID`.** Listing only cal_work events
  in a window requires using `search_events` with a manual filter in
  the response; there is no dedicated listing call.

## Contacts

- **`ENTITY` is overloaded.** Adding, listing, logging interactions, and
  setting identities all flow through one action with a `subaction`
  discriminator. A dedicated `CONTACTS_LIST_BY_RELATIONSHIP` would make
  family / friend / work filtering testable without subaction string
  matching.
- **No phone-number update verb.** Updating Caleb's phone number must
  go through `set_identity` with `platform: "phone"`. A
  `CONTACTS_UPDATE_PHONE` would be cleaner.

## Reminders

- **No `REMINDERS_LIST_OVERDUE`.** Overdue listing routes through
  `LIFE_REVIEW`, but there is no explicit overdue verb. The agent has
  to know that "review" returns overdues among other things.
- **No targeted `REMINDERS_COMPLETE_BY_TITLE` for non-id contexts.**
  `LIFE_COMPLETE` accepts `target` as either id or title, but the
  parameter description does not call this out clearly.

## Health

- **HEALTH is read-only.** Logging a workout or a manual weight entry
  has to go through `LIFE_CREATE` with kind=workout / health_metric and
  a free-form `details` payload. A dedicated `HEALTH_LOG_WORKOUT` and
  `HEALTH_LOG_WEIGHT` would let scenarios test the write path without
  smuggling the schema through `details`.

## Travel

- **`BOOK_TRAVEL` only covers flights.** No hotel search, no hotel
  booking, no rental cars. Itinerary scenarios that span all three have
  to fake the hotel / car steps as messages or notes.
- **No itinerary-share verb.** Sharing a trip itinerary uses `MESSAGE`
  send. A `TRAVEL_SHARE_ITINERARY` would let the agent emit a
  structured payload that downstream tools (calendar, partner messages)
  can consume.

## Focus / blocking

- **No `FOCUS_PRESET` action.** The user often wants "deep work mode"
  which combines APP_BLOCK + WEBSITE_BLOCK + SCHEDULED_TASK + a
  calendar block. Today the agent has to compose those manually. A
  `FOCUS_START_PRESET` would let scenarios test the composition.

## General

- **Action-name discoverability.** Many actions are namespaced
  redundantly (e.g. `LIFE` umbrella plus `LIFE_CREATE`,
  `LIFE_COMPLETE`, etc., that all share the same parameter schema).
  This is fine for the planner but makes scenario authoring noisy: the
  same intent can plausibly be expressed via either the umbrella
  (`LIFE` + `subaction: "complete"`) or the specialized name
  (`LIFE_COMPLETE`). The corpus prefers the specialized name when the
  manifest exposes it.

## Notes for Wave 4C

If gap-analysis decides to add any of the above, regenerate the action
manifest and re-run the candidate generator with the updated schemas.
The validator already enforces "action name must exist in the
manifest", so any newly-added action will be immediately available to
both the LLM generator and human authors.
