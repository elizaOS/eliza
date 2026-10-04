# @elizaos/ui

Shared React UI library for elizaOS apps: primitives, composites, layouts, the typed HTTP/WS API client, agent-surface view
instrumentation, GenUI, voice, and host capability interfaces.

Public JavaScript APIs use the package root; UI internals import owner files directly.
The app owns renderer composition and native transport selection. Consumers render
domain DTOs imported from `@elizaos/contracts`; business logic belongs to domain services. Use `bun run --cwd packages/ui storybook` for
component development. Changes reaching the app require its visual audit.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/ui build  # build
bun run --cwd packages/ui test   # tests
```

`bun run --cwd packages/ui audit:design` reports current component ownership
and possible duplication. It is advisory; lint, typecheck, rendered behavior,
and accessibility checks remain separate.

The browser-safe `TaskChoice` export renders validated
task choices in a chat or panel. The host owns transport, authorization, styling
and localized messages. It suppresses duplicate in-flight clicks and expired
responses; the durable runtime remains authoritative. Hosts that pass
`explainUnavailable` keep options activatable (`aria-disabled`) and announce why
an in-flight or expired choice cannot be used, and hide options once the choice
is no longer pending. `splitSpeechSegments`
shares lossless caption/playback chunks without importing the voice runtime.
