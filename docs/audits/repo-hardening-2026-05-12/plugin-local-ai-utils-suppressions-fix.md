# plugin-local-ai utils suppressions fix

Date: 2026-05-12

## Scope

Targeted the smallest remaining plugin-local-ai utility slice after the
environment and structured-output cleanup:

- `plugins/plugin-local-ai/utils/platform.ts`
- `plugins/plugin-local-ai/utils/tokenizerManager.ts`

No changes were made to `index.ts`, TTS, transcribe, or vision managers.

## Changes

- Removed the stale file-level `@ts-nocheck` from `platform.ts`.
- Removed the stale file-level `@ts-nocheck` from `tokenizerManager.ts`.
- No local facade types were needed; the current platform detection code and
  Transformers tokenizer calls typecheck as-is.

## Suppressions

Removed:

- `plugins/plugin-local-ai/utils/platform.ts`: file-level `@ts-nocheck`
- `plugins/plugin-local-ai/utils/tokenizerManager.ts`: file-level `@ts-nocheck`

Kept:

- `plugins/plugin-local-ai/index.ts`
- `plugins/plugin-local-ai/utils/transcribeManager.ts`
- `plugins/plugin-local-ai/utils/ttsManager.ts`
- `plugins/plugin-local-ai/utils/visionManager.ts`

These kept suppressions are outside this utility-slice write set and still
cover the broader model manager migration area.

## Verification

- `PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-local-ai typecheck`: pass
- `plugins/plugin-local-ai/node_modules/.bin/tsc --noEmit -p plugins/plugin-local-ai/tsconfig.json`: pass
- `PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-local-ai test -- __tests__/index.test.ts`: fail before test collection because `onnxruntime-node` native binding is rejected by macOS code signing with a Team ID mismatch.

Focused utility tests were not present. The closest lightweight plugin import
test is blocked by the existing native `onnxruntime-node` load failure.
