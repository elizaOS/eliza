# #10712 — live SSE streaming + thinking-channel evidence

Closes the two residual gaps found by the #10712 audit:

1. The agent "provider parity" contract test ran ONE identical fixture twice
   under `local-inference` / `cloud-resolved` string labels — a fake matrix.
   It was collapsed into a single honest case,
   `packages/agent/src/api/__tests__/conversation-stream-sse-contract.test.ts`
   (replacing `conversation-stream-provider-parity.test.ts`), because the
   route layer (`handleConversationRoutes` → `generateChatResponse`) contains
   zero provider branching: provider selection happens inside
   `runtime.useModel` (core's model registry), which that test mocks. The
   real provider-resolution path is covered live by the test below.
2. The live e2e
   (`packages/app-core/test/app/streaming-visible-text.live.e2e.test.ts`)
   now records every SSE frame (`window.__frames`) and asserts the frame
   contract against a **live model**, in addition to the existing monotonic
   visible-text growth check.

## What was proven (live, Cerebras `gpt-oss-120b` via `@elizaos/plugin-openai`)

Two consecutive green runs (`live-run-green-1.log`, `live-run-green-2.log`;
raw frames in `sse-frames-run-1.json`, `sse-frames-run-2.json`). Hand-read
findings, identical shape in both runs:

- **Status ordering:** frame 0 is `{"type":"status","kind":"thinking"}`;
  frame 1 is `{"type":"status","kind":"running_action","actionName":"REPLY"}`;
  both strictly precede the first `token` frame.
- **Observed producing status is `running_action`, not `streaming`.** Through
  the bootstrap message handler, the visible reply is produced by the REPLY
  action's handler callback, so `claimStreamSource("callback")` wins and the
  producing-phase status is `running_action` (stamped with the action name).
  The `streaming` status fires only when raw LLM tokens claim the stream via
  `onStreamChunk`; that branch is pinned by the deterministic contract test
  in packages/agent (which asserts `["thinking","streaming"]`). The live test
  therefore asserts thinking → (`streaming` | `running_action`) → tokens.
- **Monotonic token growth:** 19 `token` frames per run, each carrying the
  delta (`text`) and the cumulative `fullText`; `fullText` lengths grew
  strictly (run 1: 43…909 chars; run 2: 45…850 chars), never shrank, ~60 ms
  apart. The Playwright-sampled DOM text matched (first test's assertions).
- **Terminal `done` frame:** arrives after the last token, `fullText`
  identical to the final token's `fullText`, `agentName: "Eliza"`, and real
  usage: `{promptTokens: 2737, completionTokens: 229–234, model:
  "RESPONSE_HANDLER", provider: "openai", isEstimated: false, llmCalls: 1}`
  — proving a real provider-plugin round trip (OpenAI-compatible plugin
  pointed at `https://api.cerebras.ai/v1`).
- **Thought channel — observed absent on this path.** In both live runs the
  `done` frame carried **no `thought` field**: with Cerebras `gpt-oss-120b`
  through the REPLY-callback path, the pipeline did not attach reasoning to
  the API-chat response content. Per the field contract, absence is
  legitimate; the live test asserts the contract conditionally — when
  `thought` IS present it must be a non-empty string that appears in neither
  the `done.fullText` nor any token frame's `fullText` (reasoning never leaks
  into visible text). The thought-carrying branch of the same route code
  (`done` frame includes `thought` from `responseContent.thought`,
  `conversation-routes.ts` writeSseJson done frame) is pinned
  deterministically by the packages/agent contract test.

`live-run-red-provider-race.log` documents a real bug the new frame test
caught while iterating: `/api/health` flips ready before the deferred model
provider registers, so a fast (warm-cache) boot streamed into a provider-less
runtime and got the canned "no LLM provider configured" reply. The test now
gates on `/api/status` `canRespond` (a registered TEXT_GENERATION handler)
before streaming.

## Reproduce

```bash
# Key: CEREBRAS_API_KEY in the repo root .env (or any provider key).
set -a; source <(grep '^CEREBRAS_API_KEY=' .env); set +a
export ELIZA_LIVE_TEST=1 ELIZA_PROVIDER=cerebras
# Optional: dump the raw captured SSE frames for hand review.
export ELIZA_STREAM_FRAME_DUMP=/tmp/10712-frames.json
cd packages/app-core
node ../scripts/run-vitest.mjs run --config vitest.app-real-e2e.config.ts \
  test/app/streaming-visible-text.live.e2e.test.ts
```

Requires local Chrome (`ELIZA_CHROME_PATH` to override). First boot downloads
the gte-small embedding GGUF (~64 MB) into the persistent
`.tmp/eliza-live-models` cache; subsequent runs reuse it.

The companion deterministic contract test:

```bash
cd packages/agent
node ../scripts/run-vitest.mjs run --config vitest.config.ts \
  src/api/__tests__/conversation-stream-sse-contract.test.ts
```
