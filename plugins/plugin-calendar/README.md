# @elizaos/plugin-calendar

First-class calendar plugin for elizaOS agents.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-calendar build  # build
bun run --cwd plugins/plugin-calendar test   # tests
```

## Events from Notes

Copy `sourceNote: { agentId, noteId, contentHash }` from an exact Notes read.
Creation and approvals preserve it; dispatch checks the persisted agent, note ID
and complete title/body hash. Changed or missing notes require a fresh read and
draft review. This is freshness validation, not an atomic cross-domain transaction.

`metadata.sourceNote` records creation provenance and survives provider metadata
refreshes. It does not claim later event edits match the note. Deletion, provider
purge or cache eviction removes it with the event; there is no second store.

Import Calendar APIs from `@elizaos/plugin-calendar`. Hosts call
`registerCalendarApp()` to expose the signed Calendar page and
`installCalendarClient()` before using Calendar methods on the shared HTTP
client. Both operations are idempotent; importing the root performs neither.
Calendar components install the client methods when used.

The app renderer resolves the package to `src/browser.ts`, which keeps views and
client registration separate from runtime actions and provider storage.

## Managed Google Calendar writes

A host that sets `ELIZA_MANAGED_CALENDAR_READ_BROKER` to its private loopback
endpoint also routes owner-approved create and update requests for exact
`alpha-google:` grants through that host. Every write needs an approved owner
review; the durable mutation ledger suppresses duplicates and never retries an
unknown provider outcome. Deleting or cancelling a managed event depends on a
separately owned production service, so it stays off unless the host sets
`ELIZA_MANAGED_CALENDAR_DELETE_ENABLED=1`. Without it, a delete request is refused
with `CALENDAR_MANAGED_DELETE_UNAVAILABLE` before an owner review is queued, and
the mutation port refuses it again before any host call.

## Phone and browser Calendar controllers

Browser-safe, erasable-TypeScript controllers for device and browser hosts:

- `@elizaos/plugin-calendar/linked-sync`: explicit local-first Google Calendar
  sync. `CalendarSyncController` reviews the exact account, calendar and local
  events, saves the owner's opt-in, and runs one serialized pass through the
  shared `LinkedCalendarReconciler`; every provider request rechecks the opt-in
  and the current context. `CalendarLinkedStore` keeps owner/source-bound
  checkpoints in host storage (the provider idempotency namespace is
  configurable so installed keys are never rewritten), and
  `googleCalendarSyncPort` drives the Cloud `calendar/sync-v1` routes.
  `createCalendarSyncHost` keeps the saved opt-in (`calendarSyncSettingsSlot`
  for a compare-and-exchange slot), reports status and schedules passes only
  in the foreground (debounced local edits, return to the foreground, owner
  changes; no polling). A changed owner, Google selection or agent never
  reuses an earlier opt-in, and an optional device gate (for example an
  Android CalendarProvider bridge) is granted before the preference is saved
  and withdrawn when enabling fails. `readGoogleCalendarSyncDestination`
  verifies the calendar offers readback, conditional writes and idempotent
  creates, and names the account and calendar the review shows.
  `GoogleCalendarReader` shows one owner-chosen Google calendar read-only:
  only while the connection holds Calendar read access and Google grants at
  least reader access, bound to the exact Cloud owner, session and
  connection (a change after any await aborts the read), with the
  calendar's metadata checked before and after the feed read; cancelled
  events are omitted and all-day events keep their civil dates.
- `@elizaos/plugin-calendar/client/availability-review`: a reviewed foreground
  free/busy read. Only owner-chosen calendars are read at their reviewed
  revisions, the exact result is confirmed and re-read before sharing, free,
  cancelled and declined entries are never busy, and any stale or unknown read
  shares nothing.
