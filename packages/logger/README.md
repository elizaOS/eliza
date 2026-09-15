# @elizaos/logger

Standalone structured logging for elizaOS. Renderer and UI consumers import
`@elizaos/logger` to avoid loading the core runtime bundle. Server consumers can
also use the compatible `@elizaos/core` re-export.

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
- `Logger`, `LoggerBindings`, `LogEntry`, `LogListener` — types

## Dependencies

Only `adze` (logging backend). Secret redaction is the built-in deep-walk
redactor in `src/logger.ts`. Environment access is a tiny inlined reader
(`src/env.ts`) so the package stays a leaf with no `@elizaos/*` dependency.

## Commands

```bash
bun run --cwd packages/logger build       # tsc → dist (Node + types)
bun run --cwd packages/logger typecheck
bun run --cwd packages/logger test
```
