# `@elizaos/logger`

Standalone structured logger kept below `@elizaos/core` so renderer and UI code
can import logging without pulling the core runtime bundle. `@elizaos/core`
re-exports this package from `./logger`, so `import { logger } from "@elizaos/core"`
still works everywhere.

Repository-wide engineering and evidence requirements are inherited from the
root [`CLAUDE.md`](../../CLAUDE.md).

## Layout

```
src/
  index.ts    Public barrel: re-exports ./logger (+ default). Does NOT export getEnv
              (core has its own getEnv; re-exporting would clash in core's barrels).
  logger.ts   Structured logger, listener buffer, bindings, and redaction policy
  env.ts      Tiny inlined getEnv (node process.env / browser window.ENV) — keeps this
              package a leaf with no @elizaos/* dependency.
```

## Commands

```bash
bun run --cwd packages/logger build       # tsc --noCheck -p tsconfig.build.json → dist
bun run --cwd packages/logger typecheck   # tsc --noEmit
bun run --cwd packages/logger test
bun run --cwd packages/logger lint:check
bun run --cwd packages/logger format
```

## Gotchas

- Leaf package: depends only on `adze`. Do NOT add an `@elizaos/*`
  dependency — that would re-introduce the bundle-coupling this split removed.
  Secret redaction is the built-in deep-walk redactor in `src/logger.ts`; its
  key-name policy mirrors `@elizaos/core`'s `security/redact.ts` by hand.
- Consumers that only need logging should import `@elizaos/logger`, not
  `@elizaos/core`, to stay off the core runtime's module graph.
- The renderer resolves `@elizaos/logger` to source via a vite alias in
  `packages/app/vite.config.ts`; rebuild `dist` when the public type surface
  changes so package-mode consumers and core's typecheck see it.

## Package completion evidence

Follow the repository-wide definition of done in the root guide. For logger
changes, exercise both Node and browser consumers, inspect structured output and
redaction behavior, and verify that listener-buffer and public-type changes are
visible through both `@elizaos/logger` and the core compatibility re-export.
