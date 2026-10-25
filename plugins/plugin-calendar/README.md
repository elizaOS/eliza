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
