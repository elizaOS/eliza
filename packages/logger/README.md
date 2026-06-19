# @elizaos/logger

The standalone structured logger for elizaOS, extracted from `@elizaos/core`.

## Why this package exists

`@elizaos/core` is the agent runtime — its browser bundle is ~2 MB. Renderer and
UI code that only wanted a logger used to `import { logger } from "@elizaos/core"`,
which dragged that entire runtime bundle into the app's eager first-paint graph
(the prebuilt core bundle is not tree-shakeable, so importing one symbol pulls
all of it). Splitting the logger into its own leaf package lets those consumers
import logging without the runtime.

`@elizaos/core` re-exports everything here from `./logger`, so existing
`import { logger } from "@elizaos/core"` call sites keep working unchanged.

## Usage

```ts
import { logger, createLogger } from "@elizaos/logger";

logger.info("[MyClass] hello");
const child = createLogger({ name: "worker" });
```

## Surface

- `logger` / default export / `elizaLogger` — the shared singleton logger
- `createLogger(bindings?)` — a bound child logger
- `addLogListener` / `removeLogListener` / `recentLogs` — in-memory log tap
- `logPrompt` / `logResponse` / `logChatIn` / `logChatOut` — model-call logging
- `Logger`, `LoggerBindings`, `LogEntry`, `LogListener` — types

## Dependencies

Only `adze` (logging backend) and `fast-redact` (secret redaction). Environment
access is a tiny inlined reader (`src/env.ts`) so the package stays a leaf with
no `@elizaos/*` dependency.

## Commands

```bash
bun run --cwd packages/logger build       # tsc → dist (Node + types)
bun run --cwd packages/logger typecheck
bun run --cwd packages/logger test
```
