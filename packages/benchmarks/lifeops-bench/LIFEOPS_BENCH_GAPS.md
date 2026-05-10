# LifeOpsBench — Action Executor Gaps

This file lists action names that scenarios reference but the runner's
`_execute_action` step in `eliza_lifeops_bench/runner.py` does NOT yet
implement. Scenarios depending on a gap action are skipped by the
adapter-conformance test (`tests/test_conformance.py`) with a clear
"skipped: <reason>" message.

When you add a handler for a gap, remove it from this list and add it to
`_ACTION_HANDLERS` in `runner.py`. Keep this file mechanical: name + one-line
description + scenarios that need it. No prose.

## Currently supported action names

See `_ACTION_HANDLERS` in `runner.py`:

- `CALENDAR.create`, `CALENDAR.reschedule`, `CALENDAR.cancel`
- `MAIL.send`, `MAIL.archive`, `MAIL.mark_read`, `MAIL.star`, `MAIL.trash`
- `MESSAGE.send`
- `CONTACTS.add`, `CONTACTS.update`, `CONTACTS.delete`
- `REMINDER.create`, `REMINDER.complete`
- `NOTE.create`

## Gaps (scenarios needing these are skipped)

### Wave 2A umbrella-action vocabulary (53 scenarios skipped)

Wave 2A authored 50+ STATIC scenarios using a coarse-grained "umbrella
action" namespace where every domain has a single name and a `subaction`
discriminator inside the kwargs. Examples:

- `CALENDAR` (with `subaction` ∈ {`update_event`, `create_event`, `cancel_event`,
  `find_free_time`, `next_event`, `update_preferences`, `search_events`, ...})
- `MESSAGE` (mail + chat conflated; `subaction` ∈ {`triage`, `archive`,
  `draft_reply`, `send_imessage`, `summarize`, ...})
- `ENTITY` (contacts CRUD; `subaction` ∈ {`create`, `update`, `find`, `list`, `log`})
- `LIFE_CREATE` / `LIFE_COMPLETE` / `LIFE_REVIEW` / `LIFE_SNOOZE` (reminders)
- `PAYMENTS`, `SUBSCRIPTIONS_AUDIT`, `SUBSCRIPTIONS_CANCEL` (finance)
- `BOOK_TRAVEL` (travel)
- `HEALTH` (health-metric reads)
- `APP_BLOCK`, `WEBSITE_BLOCK`, `SCHEDULED_TASK_CREATE` (focus / sleep)

These need their own dispatch layer in `_execute_action`: read the
`subaction` and `details` keys, then fan out to the right LifeWorld helper.
Wave 2A and Wave 2G should align on which namespace is canonical (either
adapt the umbrella shape into the fine-grained handlers or rewrite the
fine-grained handlers as umbrella dispatchers). Until that's resolved,
all 53 Wave 2A scenarios are skipped by the conformance test.

### Smoke scenarios (`_smoke_scenarios.py`)

- `calendar.create_event` — uses lowercase + free-form "tomorrow 10:00" times
  that aren't directly addressable by the executor's keyed handlers. Use
  `CALENDAR.create` with explicit `event_id`, `calendar_id`, ISO `start`,
  ISO `end` instead. Smoke scenarios were authored before the executor
  contract solidified; Wave 2A's real corpus uses the new namespace.
- `mail.search` — read-only operation; LifeWorld has no search helper. Will
  be added when Wave 2A adds scenarios that genuinely need it (probably as
  a no-op that returns matching ids without mutating state).
- `mail.create_draft` — drafts aren't a distinct EmailMessage folder yet
  beyond `"drafts"`. Add a `MAIL.create_draft` handler that calls `add()`
  with `folder="drafts"` when a real scenario requires it.

### Domains not yet wired

The following EntityKinds are populated by the world but have no domain
helpers exposed via action names. Add when scenarios start asking:

- TRANSACTION / ACCOUNT / SUBSCRIPTION (finance)
- HEALTH_METRIC (health)
- LOCATION_POINT (location/travel)

These exist on LifeWorld via raw `add`/`update`/`delete`; bind them to
domain-prefixed action names in `_ACTION_HANDLERS` when needed.
