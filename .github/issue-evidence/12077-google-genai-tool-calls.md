# #12077 Google GenAI native tool-call evidence

Date: 2026-07-03

## Summary

Implemented the agent-actionable Google GenAI parser fix:

- Native Gemini function calls are now surfaced from both `response.functionCalls` and `candidates[].content.parts[].functionCall`.
- Tool calls are normalized into the runtime-compatible shape with `id`, `name`, `arguments`, `toolName`, `toolCallId`, `args`, and `input`.
- Native result calls (`messages`, `tools`, `toolChoice`, or `responseSchema`) return `{ text, toolCalls, finishReason, usage, providerMetadata }`.
- Legacy prompt-only calls still return a plain string.
- Trajectory details now record `toolCalls`, `finishReason`, provider metadata, and provider token usage when available.

## Mocked regression coverage

`plugins/plugin-google-genai/__tests__/native-plumbing.shape.test.ts` covers:

- legacy prompt-only text response remains a string.
- native text-only response returns a rich result with empty `toolCalls`.
- one Gemini tool call from `response.functionCalls`.
- multiple Gemini tool calls from `candidates[].content.parts[].functionCall`.
- generated trajectory details include the normalized tool calls.

## Live trajectory status

Added a credential-gated live trajectory test in `plugins/plugin-google-genai/__tests__/trajectory.test.ts`:

- `VITEST_LANE=post-merge bunx vitest run --config vitest.config.ts __tests__/trajectory.test.ts`
- The test self-skips unless `GOOGLE_GENERATIVE_AI_API_KEY` is present.

Credential audit, names only:

- Current process env: no `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY`, or `GOOGLE_API_KEY`.
- `/Users/shawwalters/eliza-workspace/milady/eliza/.env.local`: only Google OAuth client keys found, no Gemini/Google Generative AI key.
- `gh secret list --repo elizaOS/eliza --json name,updatedAt`: no Gemini/Google Generative AI key secret present.

Live Gemini model evidence remains blocked until a real `GOOGLE_GENERATIVE_AI_API_KEY` is provided.

## Verification

- `bunx vitest run --config vitest.config.ts __tests__/native-plumbing.shape.test.ts`: 7 passed.
- `bunx vitest run --config vitest.config.ts`: 16 passed, 1 skipped.
- `VITEST_LANE=post-merge bunx vitest run --config vitest.config.ts __tests__/trajectory.test.ts`: 1 skipped due missing key.
- `bun run --cwd plugins/plugin-google-genai typecheck`: passed.
- `bunx @biomejs/biome check plugins/plugin-google-genai/models/text.ts plugins/plugin-google-genai/__tests__/native-plumbing.shape.test.ts plugins/plugin-google-genai/__tests__/trajectory.test.ts`: passed.
- `git diff --check -- plugins/plugin-google-genai/models/text.ts plugins/plugin-google-genai/__tests__/native-plumbing.shape.test.ts plugins/plugin-google-genai/__tests__/trajectory.test.ts`: passed.
