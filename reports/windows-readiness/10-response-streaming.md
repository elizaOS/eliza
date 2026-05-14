# Streaming Pipeline Research Report

## Overview

The repo has a **single unified streaming path** for both local llama.cpp and cloud providers: tokens flow through `runtime.useModel()` → `onStreamChunk` callbacks → server-side SSE (`text/event-stream`) → browser `ReadableStream` reader → `applyStreamingTextModification` → React state. There is **no debounce / throttle / batching layer** anywhere; each emitted token causes a setState. Token-by-token streaming is wired end-to-end on desktop; the iOS XCFramework path is a documented stub.

## Sequence diagram (ascii)

```
                LOCAL (desktop, llama-server)        LOCAL (node-llama-cpp)              CLOUD (Anthropic / OpenAI)
                ---------------------------         ------------------------              --------------------------
llama-server  HTTP /v1/chat/completions stream:true
   |
   v
dflash-server.ts fetchStreamingChatCompletion()       NodeLlamaCppBackend.generate()       AI-SDK streamText(...)
   reader.read() loop, decoder.decode({stream:true})  session.prompt({ onTextChunk })       result.textStream (async iter)
   for SSE event:                                      -> text-streaming.ts pushes onto       |
     extractStreamingChatDelta(parsed)                  queue + calls args.onChunk           |
     await callbacks.onTextChunk(chunk) ------+                                              |
                                              |                                              |
                                              v                                              v
                              engine.ts NodeLlamaCppBackend / dispatcher.generate(args)  packages/core/src/runtime.ts:4644+
                              args.onTextChunk(chunk) <-- ensure-local-inference-handler  rawResponse = await handler(...)
                              .ts:349 wires onStreamChunk -> onTextChunk                  for await chunk of rawResponse.textStream:
                                                                                            deliverModelStreamChunk(chunk)
                                              |                                              |
                                              +----------------> runtime.useModel() <---------+
                                                              (runtime.ts:4538 shouldStream)
                                                              deliverModelStreamChunk -> paramsChunk / ctxChunk
                                                                          |
                                                                          v
                                                              MessageService.handleMessage callback
                                                              chat-routes.ts:1514 onStreamChunk
                                                                          |
                                                                          v
                                                              generateChatResponse opts.onChunk()
                                                              conversation-routes.ts:1264 onChunk
                                                                          |
                                                                          v
                                                              writeChatTokenSse(res, chunk, fullText)
                                                              chat-routes.ts:814   res.write("data: {...}\n\n")
                                                                          |  Node HTTP, X-Accel-Buffering: no
                                                                          v
                                                              client-base.ts:856 streamChatEndpoint
                                                              fetch() -> res.body.getReader() loop, TextDecoder
                                                              parseDataLine() -> onToken(chunk, fullText)
                                                                          |
                                                                          v
                                                              useChatSend.ts:660 setChatFirstTokenReceived(true)
                                                              applyStreamingTextModification({mode:"replace"})
                                                              useStreamingText.ts:130 setMessages(prev=>...)
                                                                          |
                                                                          v
                                                              MessageContent.tsx renders new text
```

## Key file:line refs

| Hop | File | Lines |
|----|----|----|
| llama.cpp FFI ABI | `plugins/plugin-local-inference/src/services/ffi-llm-streaming-abi.ts` | 73-208 (`TokenCallback`, `generate`, `cancel`, `close`) |
| llama-server SSE consumer (DFlash path) | `plugins/plugin-local-inference/src/services/dflash-server.ts` | 2046-2268 (`fetchStreamingChatCompletion`) |
| node-llama-cpp adapter | `plugins/plugin-local-inference/src/adapters/node-llama-cpp/text-streaming.ts` | 90-170 (queue + async iter bridge) |
| Engine.generate w/ `onTextChunk` | `plugins/plugin-local-inference/src/services/engine.ts` | 572-682 |
| Local handler registration → runtime `onStreamChunk` | `plugins/plugin-local-inference/src/runtime/ensure-local-inference-handler.ts` | 289-373 (esp. line 349 stream/streamStructured gate) |
| Anthropic streaming | `plugins/plugin-anthropic/models/text.ts` | 936-984 (`streamText` → `textStream` AsyncIterable) |
| OpenAI streaming | `plugins/plugin-openai/models/text.ts` | 866-888 (returns `textStream`) |
| Runtime stream fan-out | `packages/core/src/runtime.ts` | 4508-4750 (shouldStream / deliverModelStreamChunk / textStream loop) |
| `StreamingContext` (AsyncLocalStorage) | `packages/core/src/streaming-context.ts` | 25-120 |
| SSE writer helpers | `packages/agent/src/api/chat-routes.ts` | 797-838 |
| Per-conversation SSE endpoint | `packages/agent/src/api/conversation-routes.ts` | 1238-1414 (heartbeat 5s, onChunk/onSnapshot, deferred persistence) |
| OpenAI-compat `/v1/chat/completions` SSE | `packages/agent/src/api/chat-routes.ts` | 2085-2253 |
| Browser SSE reader | `packages/ui/src/api/client-base.ts` | 856-1055 (TextDecoder, 60s idle timeout, terminal `done` cancel) |
| Chat React state apply | `packages/ui/src/state/useStreamingText.ts` | 82-150 |
| Chat send wiring | `packages/ui/src/state/useChatSend.ts` | 657-678 |

## Transport summary

- **In-process (mobile/AOSP)**: bun:ffi `TokenCallback` on the llama.cpp decode thread → engine `onTextChunk` (synchronous, same process). See `ffi-llm-streaming-abi.ts` Line 67-77 — callback runs on the C library's background thread and is not re-entrant. iOS path is stubbed (`ios-llama-streaming.ts:178`/`215`).
- **Desktop (DFlash llama-server)**: out-of-process HTTP. Spawned `llama-server` child → `/v1/chat/completions` with `stream:true` → SSE → fetch reader in bun process. AbortController wires per-request cancel.
- **node-llama-cpp path (desktop fallback)**: in-process, `session.prompt({ onTextChunk })` push-bridges via a queue into an async iterator (`text-streaming.ts:90+`). Cancel via `stopOnAbortSignal` (engine.ts:639).
- **MLX path** (`mlx-server.ts`): same HTTP-SSE pattern as DFlash llama-server, used when Apple Silicon `ELIZA_LOCAL_MLX` is on.
- **Agent → UI**: SSE only (`text/event-stream`). No WebSocket. Custom JSON envelope `{type:"token"|"done"|"error", text, fullText, ...}` plus a periodic `: heartbeat` ping every 5s (conversation-routes.ts:1245). `X-Accel-Buffering: no` is set (chat-routes.ts:802) so any reverse proxy doesn't buffer.
- **Electrobun bridge**: only used for non-streaming RPC (`invokeDesktopBridgeRequest` in `client-chat.ts`). Streaming always falls back to plain HTTP fetch with `ReadableStream`. WebView2 supports `fetch` + `ReadableStream` body in Win11.

## Cancellation

- UI passes an `AbortSignal` via `controller.signal` into `sendConversationMessageStream` (useChatSend.ts:675). Aborting closes the fetch which closes the SSE socket; server-side `req.on("close")` flips an `aborted` flag (conversation-routes.ts:1240) which `generateChatResponse` checks via `isAborted` callbacks.
- The abort signal is plumbed into `runtime.useModel` params (runtime.ts:4617) and from there into the engine's `args.signal` (ensure-local-inference-handler.ts:358).
- For **node-llama-cpp**, the engine sets `stopOnAbortSignal` (engine.ts:639) — native cancel.
- For **llama-server**, the abort closes the per-request `fetch()` `AbortController` (dflash-server.ts:2086-2088), tearing down the upstream HTTP request, which prompts `llama-server` to release the slot.
- For **FFI mobile**, `eliza_inference_llm_stream_cancel` is the documented hook but the JS plumbing from `AbortSignal` into the FFI cancel call is not visible in the engine code searched — likely a gap.
- For **cloud (Anthropic/OpenAI)**, abort propagates into the AI-SDK `streamText` which forwards to `fetch` `signal`.

So: cancel works end-to-end **on desktop**; mobile FFI cancel is plumbed at the ABI level but UI→ABI wiring needs verification.

## Backpressure

There is effectively **no backpressure**:

- The SSE writer does `res.write(...)` without honoring the kernel `drain` event (chat-routes.ts:811). Node will buffer in memory if the socket is slow.
- The browser `getReader().read()` loop applies natural backpressure (it pulls), but it never `await`s `setState` — React batches by default.
- `applyStreamingTextModification` (useStreamingText.ts:134) does `setMessages(prev => ...)` per token; if tokens arrive faster than React can render, React 18 automatic batching coalesces, but there is no explicit `requestAnimationFrame`/throttle. Under hundreds of TPS this becomes hot.

## Cloud vs local shape

Cloud providers (Anthropic, OpenAI) return a **TextStreamResult** object with `textStream` AsyncIterable, and the runtime loops it (runtime.ts:4659) into `deliverModelStreamChunk`. Local providers (mode = `isLocalProvider`) instead **invoke `onStreamChunk` synchronously** from inside their handler (runtime.ts:4595-4604). The downstream observer code is identical from `deliverModelStreamChunk` onward, so shape parity holds end-to-end. Note: only LOCAL providers get the `onStreamChunk` callback injected; cloud providers must return `textStream`. If a cloud provider returns a plain string when `stream:true`, the streaming branch is skipped entirely and the UI gets one big chunk at the end — a silent-degradation risk.

## Known issues / risks

1. **Cloud non-streaming fallback is invisible**: runtime.ts:4654 gates streaming on `isTextStreamResult(rawResponse)`. A misconfigured cloud plugin that returns a string will silently drop into non-streaming mode. No log warning.
2. **No backpressure on SSE write**: `res.write` ignores the `drain` boolean. Slow clients (mobile WebView over slow link) will balloon Node memory under long generations.
3. **React state churn**: One `setState` per token, no `flushSync`/RAF. At 200 TPS on a busy thread, React will batch but devtools/dev mode will visibly judder. Consider `useTransition` or batching by frame.
4. **iOS FFI streaming is a stub**: `ios-llama-streaming.ts:215` `buildIosBinding is a stub`; `streamingLlm` defaults to false in `inference-capabilities.ts:115`. Mobile streaming on iOS is not yet wired.
5. **FFI cancel not wired from AbortSignal on mobile**: ABI surface has `eliza_inference_llm_stream_cancel`, but no code path was found in the bun:ffi adapters that listens to `args.signal.aborted` and calls it.
6. **`fetchStreamingChatCompletion` JSON.parse can throw on partial SSE** (dflash-server.ts:2125) — there's no try/catch around `JSON.parse(data)`. A partial frame at the trailing buffer flush (line 2241-2242) could throw; should be wrapped.
7. **SSE idle timeout is 60s** (client-base.ts:1003). A genuinely slow local model on cold load can exceed this; user sees "SSE idle timeout — no data for 60s" with no recovery.
8. **Heartbeat is one-way**: server writes `: heartbeat\n\n` every 5s but the client doesn't echo. If the server hangs *before* generation starts, only the 60s idle timeout catches it.
9. **Windows specifics**: `llama-server` child process stdout/stderr piped — no line-buffered concerns since transport is HTTP-SSE, not stdout. WebView2 `fetch`+`ReadableStream` works on Win11 26200. `dev-desktop.err.log` shows only build warnings, no streaming errors. No `\r\n` vs `\n` issues spotted — `findSseEventBreak` (client-base.ts:904) handles both CRLF and LF.
10. **`streamingLlm: true` default-on assumption** in `detectMobileCapabilities` (ffi-llm-streaming-abi.ts:411-417) — if symbol probe missing, it assumes yes. Could cause hard runtime failures rather than clean fallback.

## Prioritized checklist

**P0 — correctness**
- Wrap `JSON.parse(data)` in `fetchStreamingChatCompletion` (`dflash-server.ts:2125`) in try/catch; treat parse failure on the trailing flush as benign.
- Verify mobile FFI cancel path: add `args.signal.addEventListener('abort', () => abi.eliza_inference_llm_stream_cancel(handle))` in AOSP/Capacitor adapters; add a regression test.
- Detect cloud-provider non-streaming responses when `stream:true` was requested — log a warning and emit a synthesized one-chunk stream so UX doesn't silently degrade.

**P1 — UX**
- Add `flushSync` or `requestAnimationFrame` batching in `applyStreamingTextModification` to coalesce >1 token/frame; measure with a 200-TPS local model.
- Honor `res.write` backpressure: when `false`, await `'drain'` before continuing in `writeChatTokenSse`.
- Raise SSE idle timeout for cold-start cases or send a synthetic `: starting` heartbeat at request acceptance time so 60s clock resets after queue.

**P2 — observability / tests**
- Add an end-to-end test (already partially in `packages/agent/src/api/__tests__/conversation-streaming.test.ts`) that asserts first-token latency < expected and per-chunk delivery for local llama-server, node-llama-cpp, and cloud Anthropic.
- Add a streaming pipeline bench to CI to detect coalescing regressions (`packages/app-core/scripts/streaming-pipeline-bench.ts` exists; wire to a perf gate).
- Add a tracing hook on `model_stream_chunk` pipeline hook (already in runtime.ts:4567) that reports interval histogram between chunks; surface in dev tools.

**P3 — finish iOS**
- Land the iOS XCFramework that re-exports `eliza_inference_llm_stream_*` so `loadIosStreamingLlmBinding()` (`ios-llama-streaming.ts`) stops returning null.
