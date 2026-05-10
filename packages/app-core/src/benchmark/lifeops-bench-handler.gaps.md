# LifeOpsBench fake-backend method coverage

The TS-side `LifeOpsFakeBackend` implements only the actions Wave 2A's
hand-authored scenarios actually exercise. Everything else throws
`LifeOpsBackendUnsupportedError`, and the `/message` route surfaces
that as `tool_calls[i] = { ok: false, error: "unsupported: ..." }`
so scoring can detect it explicitly rather than silently no-op.

## Supported methods (Wave 2A scope)

| Method | Mutates | Notes |
| --- | --- | --- |
| `calendar.create_event` | yes | Requires existing `calendar_id`. |
| `calendar.move_event` | yes | Updates `start` / `end`. |
| `calendar.cancel_event` | yes | Sets `status = "cancelled"`. |
| `calendar.list_events` | no | Filters by `calendar_id` + `start` / `end`. |
| `mail.search` | no | Supports `from:`, `subject:`, `is:unread`, `in:`, free text. |
| `mail.create_draft` | yes | Persists in `email` store with `folder = "drafts"`. |
| `mail.send` | yes | If `draft_id` exists, flips to `sent`; else creates a new sent message. |
| `mail.archive` | yes | Sets `folder = "archive"`. |
| `mail.mark_read` | yes | Sets `is_read = true`. |
| `reminders.create` | yes | Auto-creates list when missing. |
| `reminders.complete` | yes | Sets `completed_at = now`. |
| `reminders.list` | no | Filters by `list_id` + `include_completed`. |
| `messages.send` | yes | Requires existing `conversation_id`. |
| `notes.create` | yes | Defaults `source = "apple-notes"`. |
| `contacts.search` | no | Substring match on display/given/family/email. |

## Known gaps (file when scenarios need these)

The Wave 2A authors should append to this list when a scenario references
an action that's not yet wired. Wave 4C (gap analysis) closes these.

- `messages.search`
- `messages.mark_read`
- `notes.update` / `notes.delete`
- `contacts.create` / `contacts.update`
- `finance.list_transactions` / `finance.categorize`
- `subscriptions.list` / `subscriptions.cancel`
- `health.read` / `health.aggregate`
- `travel.search_flights` / `travel.book` (Duffel-shaped)
- `focus.start_block` / `focus.end_block`

The `LifeOpsFakeBackend.SUPPORTED_METHODS` set is the authoritative list
at code level — keep this doc in sync when extending the backend.
