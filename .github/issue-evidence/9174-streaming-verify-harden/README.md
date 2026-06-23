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

## Live-model UI video — N/A on this dev box (key + model limitation)

The issue itself flags the UI video as "the one piece not verifiable headless on
a dev box." On this machine it is genuinely blocked:

- **Cloud:** both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in `.env` return
  **401** (`authentication_error` / `invalid_api_key`) against the live APIs, so
  a real cloud trajectory cannot be produced here.
- **Local:** no fused model is installed (`MODELS_DIR` unset, no `.gguf` /
  eliza-1 bundle present), so the FFI path cannot be exercised end-to-end. The
  local FFI emission was already verified on Windows with the real fused lib
  (issue body).

### Manual E2E protocol (for a maintainer with working keys / a local model)

1. `bun run dev` (boots API + dashboard).
2. **Cloud:** set a valid `ANTHROPIC_API_KEY`, select an Anthropic agent, send a
   message that elicits a multi-sentence reply. Observe the reply rendering
   token-by-token. **Local:** set `MODELS_DIR` + a fused model, select the local
   agent, repeat. Optionally set `ELIZA_LOCAL_STREAM_TOKENS_PER_STEP=8` to
   compare smoothness.
3. Capture a full-page screen recording of each (`bun run test:e2e:record`).
4. In devtools → Network, confirm `POST /api/conversations/:id/messages/stream`
   is the request and that `data: {"type":"token"}` frames stream in before the
   terminal `done` frame (matches `sse-token-timeline.txt`).

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
