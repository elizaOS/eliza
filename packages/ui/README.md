# @elizaos/ui

Shared React UI library for elizaOS apps: primitives, composites, layouts, the agent
dashboard shell (`App.tsx`), the typed HTTP/WS API client, agent-surface view
instrumentation, GenUI, voice, and platform/bridge glue.

Shared React components and application surfaces. Consumers render domain DTOs; business
logic belongs to domain services. Use `bun run --cwd packages/ui storybook` for
component development. Changes reaching the app require its visual audit.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/ui build  # build
bun run --cwd packages/ui test   # tests
```
