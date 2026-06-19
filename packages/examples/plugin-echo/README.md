# elizaos-plugin-echo

Reference **third-party** elizaOS plugin. It exists to demonstrate, end to end,
how a community plugin is built and listed in the
[community plugin registry](../../registry/README.md).

It is deliberately tiny: one [`ECHO`](src/actions/echo.ts) action that repeats
the user's message back. No config, no services, no secrets.

```ts
import { echoPlugin } from "elizaos-plugin-echo";
// add echoPlugin to your agent's plugin list
```

## Why this is "third-party"

- The package name is **unscoped** (`elizaos-plugin-echo`), not `@elizaos/*` —
  that scope is reserved for first-party packages.
- It carries the `elizaos` keyword so the runtime auto-recognizes it as a plugin.
- It is listed in the registry by a single JSON file:
  [`packages/registry/entries/third-party/elizaos-plugin-echo.json`](../../registry/entries/third-party/elizaos-plugin-echo.json).

See [Add a third-party plugin to the registry](../../registry/README.md#adding-a-third-party-plugin)
for the full walkthrough.

## Develop

```bash
bun run --cwd packages/examples/plugin-echo typecheck
bun run --cwd packages/examples/plugin-echo test
```
