# App Core Electrobun Suppressions Fix

Date: 2026-05-12

## Scope

Removed local TypeScript suppressions in:

- `packages/app-core/platforms/electrobun/src/index.ts`
- `packages/app-core/platforms/electrobun/src/native/canvas.ts`

Added a local Electrobun constructor adapter in:

- `packages/app-core/platforms/electrobun/src/electrobun-window-options.ts`

## Changes

- Replaced the Bun streaming fetch `@ts-expect-error` with a local
  `RequestInit & { duplex: "half" }` request init type. This preserves the
  runtime `duplex: "half"` option needed when proxying streaming request
  bodies.
- Added `createElectrobunBrowserWindow`, typed with the published
  `BrowserWindow` constructor parameters plus the runtime-supported
  `icon` and `partition` fields.
- Routed main, surface, canvas, and game window construction through the
  adapter so call sites no longer need Electrobun option suppressions.

## Suppression Status

- Removed: Bun fetch `duplex` suppression in `index.ts`.
- Removed: Electrobun `icon` suppressions in `index.ts`.
- Removed: Electrobun `partition` suppressions in `native/canvas.ts`.
- Kept: none under `packages/app-core/platforms/electrobun/src`.

## Verification

Commands run:

```sh
rg -n "@ts-expect-error" packages/app-core/platforms/electrobun/src
```

Result: passed. No Electrobun source suppressions remain.

```sh
bun run --cwd packages/app-core/platforms/electrobun typecheck
```

Result: did not start because `bun` is not on this shell's PATH.

```sh
packages/app-core/platforms/electrobun/node_modules/.bin/tsc --noEmit -p packages/app-core/platforms/electrobun/tsconfig.json
```

Result: failed on an unrelated pre-existing error outside the Electrobun
write set:

- `packages/agent/src/runtime/conversation-compactor-runtime.ts(240,41)`:
  `compactionHistory?: unknown[]` is not assignable to `Metadata`.

The rerun after the local import fix reported only that unrelated agent
metadata error and no Electrobun suppression/type errors.
