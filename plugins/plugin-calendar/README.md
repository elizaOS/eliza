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
