# LifeOpsBench — Action Executor Gaps

This file lists action names that scenarios reference but the runner's
`_execute_action` step in `eliza_lifeops_bench/runner.py` does NOT yet
implement, plus subactions that are silently no-op'd because the underlying
LifeWorld lacks an entity for them. Scenarios depending on a gap are
skipped by the adapter-conformance test (`tests/test_conformance.py`)
with a clear "skipped: <reason>" message.

When you add a handler for a gap, remove it from this list and add it to
`_ACTION_HANDLERS` in `runner.py`. Keep this file mechanical: name + one-line
description + scenarios that need it. No prose.

## Currently supported action names

See `_ACTION_HANDLERS` in `runner.py` (Wave 2H umbrella reconciliation).

**Fine-grained vocabulary** (inline conformance corpus + adapters that emit
explicit tool ids):

- `CALENDAR.create`, `CALENDAR.reschedule`, `CALENDAR.cancel`
- `MAIL.send`, `MAIL.archive`, `MAIL.mark_read`, `MAIL.star`, `MAIL.trash`
- `MESSAGE.send` (`{conversation_id, from_handle, to_handles, text}` shape)
- `CONTACTS.add`, `CONTACTS.update`, `CONTACTS.delete`
- `REMINDER.create`, `REMINDER.complete`
- `NOTE.create`

**Umbrella vocabulary** (Wave 2A scenarios + Eliza adapter — the canonical
runtime surface; dispatched on `kwargs.subaction` or `kwargs.operation`):

- `CALENDAR` — subactions: `create_event`, `update_event`, `delete_event`,
  `propose_times`, `search_events`, `check_availability`, `next_event`,
  `update_preferences`. Read-only / preference subactions are no-ops at
  the LifeWorld layer (no place to persist them); state hash matches
  trivially because both replays no-op together.
- `MESSAGE` — operations: `send` (gmail mail OR chat sources
  imessage/whatsapp/slack/telegram/signal/sms/discord), `draft_reply`
  (gmail drafts), `manage` (`{archive, mark_read, trash, star}`),
  plus read-only `triage`, `search_inbox`, `list_channels`, `read_channel`,
  `read_with_contact`. The `source` field disambiguates mail vs chat.
- `ENTITY` — subactions: `add` (creates Contact), `set_identity`
  (updates Contact phones/email), `log_interaction` and `list` (read-only
  no-ops).
- `LIFE_CREATE` — `subaction=create` with `details.kind` ∈
  `{reminder, alarm, workout, health_metric}`. Reminders/alarms create
  Reminder rows; workouts persist as a Note tagged "workout"; health
  metrics persist as HealthMetric.
- `LIFE_COMPLETE`, `LIFE_SNOOZE` — operate on `reminder_*` ids only.
- `LIFE_REVIEW` — read-only no-op.
- `HEALTH` — read-only metric reads (no-op for state hash).
- `PAYMENTS` — read-only dashboard / list_transactions (no-op).
- `SUBSCRIPTIONS_AUDIT` — read-only no-op.
- `SUBSCRIPTIONS_CANCEL` — mutates Subscription.status to `cancelled`
  when `confirmed=True`. Resolves by `serviceSlug` first, then
  case-insensitive `serviceName` (with substring fallback to handle
  "Disney+" vs "Disney Plus").
- `BOOK_TRAVEL` — returns offers without booking; no-op for state.
- `APP_BLOCK`, `WEBSITE_BLOCK` — focus blocks not modeled in LifeWorld;
  no-op for state.
- `SCHEDULED_TASK_CREATE` — modeled as a Reminder on `list_personal`
  with the trigger's `atIso` as the due time. The reminder id is derived
  deterministically from kwargs so replays produce identical state.

## Determinism contract

For umbrella actions that create new entities without an explicit id
(every `LIFE_CREATE`, `MESSAGE/send`-by-contact, draft replies, scheduled
tasks), the executor derives the id via SHA-256 over the canonical-json
kwargs. Two replays of the same `Action` against two different worlds
produce identical mutations — the only way state-hash matching can succeed
for these scenarios.

## Gaps (would require new LifeWorld semantics)

The following umbrella subactions currently no-op because LifeWorld has
no entity to store them. Scenarios that exercise them still pass the
conformance rubric (the no-op replays match), but a *behavioral* check —
e.g. "did the agent actually queue a focus block for the right duration?" —
would need new entity support.

- `APP_BLOCK / WEBSITE_BLOCK`: focus-block sessions. Suggested resolution:
  add a `FocusBlock` entity with hostname/package/duration/start_at and
  bind to `EntityKind.FOCUS_BLOCK`. Wave 4C.
- `ENTITY/log_interaction`: contact-touch log. Suggested resolution: add
  an `InteractionLog` entity (`contact_id, occurred_at, notes`). Wave 4C.
- `ENTITY/list` and `LIFE_REVIEW`: pure reads. No state to persist; OK as
  no-op.
- `CALENDAR/check_availability`, `CALENDAR/next_event`,
  `CALENDAR/propose_times`, `CALENDAR/search_events`: read-only. OK as
  no-op.
- `CALENDAR/update_preferences`: planner config, not entity store. Add a
  `UserPreferences` entity if/when scenarios need to verify the change
  persisted. Wave 4D.
- `HEALTH` (all subactions): manifest-level read-only. OK as no-op for
  state; the read payload is what scenarios actually score against.
- `PAYMENTS/dashboard`, `PAYMENTS/list_transactions`,
  `SUBSCRIPTIONS_AUDIT`: read-only listings. OK as no-op.
- `MESSAGE/triage`, `MESSAGE/search_inbox`, `MESSAGE/list_channels`,
  `MESSAGE/read_channel`, `MESSAGE/read_with_contact`: read-only. OK as
  no-op.
- `MESSAGE/draft_reply` for non-gmail sources: chat drafts not modeled;
  no-op. Suggested: add a `Draft` entity bound to a `Conversation`. Wave 4C.
- `BOOK_TRAVEL`: offer-return, no booking by design. OK as no-op until
  flight booking is modeled (Wave 4C).
- `SCHEDULED_TASK_CREATE`: folded into the reminder store. If scenarios
  start needing scheduled-task semantics that diverge from reminders
  (escalation, retry, source tracking), promote to a real
  `ScheduledTask` entity. Wave 4C.
