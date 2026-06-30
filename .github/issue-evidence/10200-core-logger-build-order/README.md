# #10200 core/logger build-order evidence

## What failed

`packages/core/build.ts` emits declarations that re-export `@elizaos/logger`.
When `packages/logger/dist` is absent in a clean workspace, invoking the core
build implementation without first building logger fails during declaration
generation:

- `baseline-core-build-without-logger.log` — controlled repro after deleting
  `packages/logger/dist` and `packages/core/dist`; exits with
  `TS2307: Cannot find module '@elizaos/logger'`.

## What changed

`packages/core` now runs `bun run --cwd ../logger build` in `prebuild`, before
contracts and before `build.ts` declaration generation. Turbo already models
this dependency; this fixes the documented package-local command.

## Verification

- `build-core-test.log` — script drift guard, 7 pass.
- `core-build.log` — `bun run --cwd packages/core build` succeeds from the
  cleaned dist state and shows logger building first.
- `plugin-commands-build.log` — direct dependency build succeeds.
- `plugin-telegram-build.log` — downstream Telegram build succeeds.
- `biome.log` — focused Biome check succeeds.
