# @elizaos/logger — Agent Guide

Standalone structured logger extracted from `@elizaos/core` so renderer/UI code
can import logging without pulling the ~2 MB core runtime bundle. `@elizaos/core`
re-exports this package from `./logger`, so `import { logger } from "@elizaos/core"`
still works everywhere.

## Layout

```
src/
  index.ts    Public barrel: re-exports ./logger (+ default). Does NOT export getEnv
              (core has its own getEnv; re-exporting would clash in core's barrels).
  logger.ts   The logger implementation (adze + fast-redact). Moved verbatim from core.
  env.ts      Tiny inlined getEnv (node process.env / browser window.ENV) — keeps this
              package a leaf with no @elizaos/* dependency.
```

## Commands

```bash
bun run --cwd packages/logger build       # tsc --noCheck -p tsconfig.build.json → dist
bun run --cwd packages/logger typecheck   # tsgo --noEmit
bun run --cwd packages/logger test
```

## Gotchas

- Leaf package: depends only on `adze` + `fast-redact`. Do NOT add an `@elizaos/*`
  dependency — that would re-introduce the bundle-coupling this split removed.
- Consumers that only need logging should import `@elizaos/logger`, not
  `@elizaos/core`, to stay off the core runtime's module graph.
- The renderer resolves `@elizaos/logger` to source via a vite alias in
  `packages/app/vite.config.ts`; rebuild `dist` (`bun run build`) when the public
  `.d.ts` surface changes so packages-mode + core's typecheck see it.
- Repo-wide rules (logger-only, ESM, naming) live in the root AGENTS.md.
