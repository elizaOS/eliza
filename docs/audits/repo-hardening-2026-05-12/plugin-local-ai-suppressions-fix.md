# plugin-local-ai suppressions fix

Date: 2026-05-12

## Scope

Targeted the initial plugin-local-ai suppressions in:

- `plugins/plugin-local-ai/environment.ts`
- `plugins/plugin-local-ai/structured-output.ts`

No model manager rewrites were performed.

## Changes

- Removed the stale file-level `@ts-nocheck` from `environment.ts`; the current logger and zod usage typechecks without local casts.
- Removed the file-level `@ts-nocheck` from `structured-output.ts`.
- Added narrow node-llama-cpp boundary types in `structured-output.ts` for the places where elizaOS `JSONSchema` is intentionally forwarded to the stricter `GbnfJsonSchema` API.

## Suppressions

Removed:

- `plugins/plugin-local-ai/environment.ts`: file-level `@ts-nocheck`
- `plugins/plugin-local-ai/structured-output.ts`: file-level `@ts-nocheck`

Kept:

- `plugins/plugin-local-ai/index.ts`
- `plugins/plugin-local-ai/utils/platform.ts`
- `plugins/plugin-local-ai/utils/tokenizerManager.ts`
- `plugins/plugin-local-ai/utils/transcribeManager.ts`
- `plugins/plugin-local-ai/utils/ttsManager.ts`
- `plugins/plugin-local-ai/utils/visionManager.ts`

These remaining suppressions are outside this change's requested starting scope and still point at the broader transformers/core type migration area.

## Verification

- `PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-local-ai typecheck`: pass
- `PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-local-ai test -- __tests__/structured-output.test.ts`: pass

The focused test command emits the existing package export-order warning for `package.json`; tests still pass.
