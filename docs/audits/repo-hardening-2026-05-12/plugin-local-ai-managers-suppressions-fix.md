# plugin-local-ai managers suppressions fix

Date: 2026-05-12

## Scope

Targeted the assigned plugin-local-ai manager slice:

- `plugins/plugin-local-ai/index.ts`
- `plugins/plugin-local-ai/utils/transcribeManager.ts`
- `plugins/plugin-local-ai/utils/ttsManager.ts`
- `plugins/plugin-local-ai/utils/visionManager.ts`

## Changes

- Removed file-level `@ts-nocheck` from all four assigned files.
- Added narrow runtime-boundary helpers in `index.ts` for current
  `@elizaos/core` model parameter shapes:
  - embedding accepts `{ text }`, string, or null;
  - tokenizer encode prefers `{ prompt, modelType }` while retaining legacy
    `{ text }` support;
  - image description accepts string URLs or `{ imageUrl }`;
  - transcription rejects non-Buffer inputs with a local-ai-specific error;
  - text-to-speech extracts text from string or `{ text }`.
- Kept local text generation's internal `modelType` extension on a local
  `LocalGenerateTextParams` type instead of widening `GenerateTextParams`.
- Typed the native text/tool-call result boundary as the same `string & object`
  pattern used by adjacent text providers.
- Converted the local TTS manager's `Readable` output to `Buffer` at the plugin
  model boundary so `ModelType.TEXT_TO_SPEECH` matches the current core binary
  result contract.
- Replaced old logger message/context call shapes with the current typed
  context-first forms where needed.
- Added local guards for `whisper-node` module resolution and Transformers
  text-to-audio output shape.
- Fixed the vision Buffer-to-Blob boundary with an explicit `ArrayBuffer` copy.

## Suppressions

Removed:

- `plugins/plugin-local-ai/index.ts`: file-level `@ts-nocheck`
- `plugins/plugin-local-ai/utils/transcribeManager.ts`: file-level `@ts-nocheck`
- `plugins/plugin-local-ai/utils/ttsManager.ts`: file-level `@ts-nocheck`
- `plugins/plugin-local-ai/utils/visionManager.ts`: file-level `@ts-nocheck`

Kept:

- None in the assigned files. A focused scan of the assigned files found no
  `@ts-nocheck`, `@ts-ignore`, `@ts-expect-error`, or broad `any`.

## Verification

- `PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-local-ai typecheck`: pass
- `PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-local-ai test __tests__/structured-output.test.ts`: pass, 7 tests
- `PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-local-ai test __tests__/integration.test.ts`: pass with skips, 3 skipped because `LOCAL_AI_TEST_MODEL_PATH` is not set
- `git diff --check -- plugins/plugin-local-ai/index.ts plugins/plugin-local-ai/utils/transcribeManager.ts plugins/plugin-local-ai/utils/ttsManager.ts plugins/plugin-local-ai/utils/visionManager.ts`: pass

## Blockers

- `PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-local-ai test __tests__/index.test.ts __tests__/structured-output.test.ts`: fails before collecting `index.test.ts` because importing `index.ts` loads `onnxruntime-node`, and macOS rejects
  `node_modules/.bun/onnxruntime-node@1.24.3/node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node` with a code-signature Team ID mismatch. The same run still executes and passes `structured-output.test.ts`.
