# @elizaos/plugin-calendar

First-class calendar plugin for elizaOS agents.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-calendar build  # build
bun run --cwd plugins/plugin-calendar test   # tests
```

Import Calendar APIs from `@elizaos/plugin-calendar`. Hosts call
`registerCalendarApp()` to expose the signed Calendar page and
`installCalendarClient()` before using Calendar methods on the shared HTTP
client. Both operations are idempotent; importing the root performs neither.
Calendar components install the client methods when used.

The app renderer resolves the package to `src/browser.ts`, which keeps views and
client registration separate from runtime actions and provider storage.
