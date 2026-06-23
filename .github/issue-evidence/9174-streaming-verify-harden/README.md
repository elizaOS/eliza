# Evidence — #9174 Streaming responses: verify + harden token-by-token text

**Branch:** `feat/streaming-verify-harden-9174` · **Base:** `develop`

The pipeline was already wired end-to-end (see issue body). This change **verifies
and hardens** it: a configurable local-streaming granularity knob, regression
tests locking every layer of the token-stream contract, and a confirmation that
the dashboard always streams. No new streaming mechanism was added.

## What changed

| Area | Change |
| --- | --- |
| Local granularity knob | `FfiStreamingRunner` per-step token cap is now configurable via `ELIZA_LOCAL_STREAM_TOKENS_PER_STEP` (default `32`, clamped `1`–`512`) **and** a per-call `maxTokensPerStep` arg. Lower = smoother token-by-token local streaming, at the cost of more JS↔FFI round-trips. Default behaviour is unchanged. |
| Core export | `resolveDynamicPromptStreamFields` exported from `runtime.ts` for regression coverage of the default `text`-field stream contract. |
| Regression tests | New/extended tests at all four layers (local FFI, core extractor, transport, frontend). |
| Docs | `ELIZA_LOCAL_STREAM_TOKENS_PER_STEP` documented in the plugin `CLAUDE.md`/`AGENTS.md`. |

## Regression coverage — the verification (automated, reproducible)

Full output: [`regression-test-output.txt`](./regression-test-output.txt) — **90 tests pass.**

| Issue checkbox | Layer | Locking test(s) |
| --- | --- | --- |
| (a) `ensure-local-inference-handler` wires `onStreamChunk → onTextChunk` | local FFI | `plugins/plugin-local-inference/src/runtime/ensure-local-inference-handler.test.ts` — per-token delivery; **+ new:** plain `stream:true` wiring, and negative (non-streaming ⇒ no `onTextChunk`) |
| (b) extractor emits the `text`-field delta (not raw markup) | core | `packages/core/src/utils/__tests__/streaming-field-events.test.ts` — **+ new** `text`-field clean-delta + no-control-field-leak; `packages/core/src/runtime/__tests__/resolve-stream-fields.test.ts` — **new** default = `text`, opt-in/opt-out, order; `streaming-use-model.test.ts` — emits only the clean reply, with accurate `accumulated` |
| (c) chat-routes append-vs-snapshot via `resolveStreamingUpdate` | transport | `packages/agent/src/api/__tests__/conversation-streaming.test.ts` — **+ new** clean extension ⇒ `onChunk` delta; in-place revision ⇒ `onSnapshot`; `sse-wire-streaming.test.ts` — N token frames + 1 done frame, no buffering |
| Local granularity knob | local FFI | `plugins/plugin-local-inference/src/services/ffi-streaming-runner.test.ts` — **new** default 32, env override, per-call override, clamping |
| Dashboard always streams | frontend | `packages/ui/src/state/useChatSend.test.tsx` — **+ new** happy path uses the streaming endpoint, never the non-streaming one (reserved for 404 recovery), first-token signal fires |

## Real transport demonstration — timestamped SSE token timeline

[`sse-token-timeline.txt`](./sse-token-timeline.txt) was captured by driving the
**real** `generateChatResponse()` → `writeChatTokenSse()` server code with a
model that emits 8 tokens 35 ms apart. Each SSE `data: {type:token}` frame
arrived at a **distinct** wall-clock time (≈36 ms apart), carrying the delta and
accumulated `fullText` — i.e. genuine incremental emission over the wire, not a
single batched frame at the end.

```
frame  1 | t=+  40ms (+ 40ms) | delta="Streaming " | fullText="Streaming "
...
frame  8 | t=+ 291ms (+ 35ms) | delta="dashboard." | fullText="Streaming works token by token into the dashboard."
Total token frames: 8 (one per model token)
Distinct arrival times: 8 (frames arrived incrementally, NOT batched at the end)
```

## Live cloud model — VERIFIED token-by-token (real LLM)

[`live-cloud-streaming-timeline.txt`](./live-cloud-streaming-timeline.txt) was
captured against a **live OpenAI-compatible cloud model** (Together AI,
`Qwen/Qwen2.5-7B-Instruct-Turbo`) through plugin-openai's real AI-SDK
`streamText` path — the exact cloud code the issue references. The provider
fired `onStreamChunk` **12 times, once per token** (`"one"`, `" two"`,
`" three"`, … `" twelve"`) across 7 distinct arrival times, and the deltas
reconstructed the full reply:

```
chunk  1 | t=+ 4508ms | "one"
chunk  2 | t=+ 4613ms | " two"
...
chunk 12 | t=+ 4618ms | " twelve"
Total onStreamChunk calls: 12 | distinct arrival times: 7
Reconstructed reply: "one two three four five six seven eight nine ten eleven twelve"
```

Test: `plugins/plugin-openai/__tests__/cloud-streaming.live.test.ts` (skips with
a warning when `OPENAI_BASE_URL`/`OPENAI_API_KEY` are unset). Reproduce:

```bash
OPENAI_API_KEY=<together-key> \
OPENAI_BASE_URL=https://api.together.xyz/v1 \
OPENAI_SMALL_MODEL=Qwen/Qwen2.5-7B-Instruct-Turbo \
bun run --cwd plugins/plugin-openai vitest run --config vitest.live.config.ts __tests__/cloud-streaming.live.test.ts
```

### The full chain, each link verified with real code

1. **Cloud model → `onStreamChunk` per token** — `live-cloud-streaming-timeline.txt`
   (real Together AI model, real plugin-openai `streamText`).
2. **`onStreamChunk` deltas → incremental SSE `token` frames** —
   `sse-token-timeline.txt` (real `generateChatResponse` → `writeChatTokenSse`)
   + `conversation-streaming.test.ts` + `sse-wire-streaming.test.ts`.
3. **Dashboard reads SSE, always via the streaming endpoint** —
   `useChatSend.test.tsx`, with RAF-coalesced `mergeStreamingText` render.

The original `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` in `.env` are dead (401), and
no local fused model is installed here (`MODELS_DIR` unset, no `.gguf`/eliza-1
bundle) — the local FFI emission was verified on Windows with the real fused lib
(issue body). The Together AI route above provides the real-LLM cloud trajectory
in their place.

### Remaining: in-browser pixel capture (video)

The only piece not captured headless is a screen-recording of the rendered DOM.
Functionally it is covered by link 3 above (the SSE token frames are exactly
what the dashboard consumes). To record the video on a workstation:

1. `bun run dev` with the Together AI env above (or any working provider).
2. Send a message that elicits a multi-sentence reply; observe token-by-token
   rendering. Optionally `ELIZA_LOCAL_STREAM_TOKENS_PER_STEP=8` for local.
3. `bun run test:e2e:record`; in devtools → Network confirm
   `POST /api/conversations/:id/messages/stream` streams `data: {"type":"token"}`
   frames before the terminal `done` frame (matches `sse-token-timeline.txt`).

## Reproduce the automated evidence

```bash
# local FFI
bun run --cwd plugins/plugin-local-inference test -- src/services/ffi-streaming-runner.test.ts src/runtime/ensure-local-inference-handler.test.ts
# core
bun run --cwd packages/core test -- src/utils/__tests__/streaming-field-events.test.ts src/runtime/__tests__/resolve-stream-fields.test.ts src/runtime/__tests__/streaming-use-model.test.ts
# transport
bun run --cwd packages/agent test -- src/api/__tests__/conversation-streaming.test.ts src/api/__tests__/sse-wire-streaming.test.ts
# frontend
bun run --cwd packages/ui test -- src/state/useChatSend.test.tsx
```
