# #13983 — native chat stream can hang forever (Android liveness)

`createNativeStreamingResponse` (`packages/ui/src/api/native-agent-stream.ts`) settled its head only on `agentStreamResponse` and closed the body only on `agentStreamComplete`, with the sole liveness net being the caller's `completion` promise — which **Android's `requestStream` does not supply** (`Promise<{streamId}>`, no `completion`). So a dropped head/terminal event (agent crash, killed loopback, lost Capacitor event) left the awaited promise **never settling**: the reply spinner hung, the buffered fallback (which only catches rejections) was bypassed, and `detach()` never ran → the 3 `agentStream*` listeners leaked (ties #12626).

## Fix (pure liveness/control-flow — no credit/money arithmetic touched)
- **Completion RESOLUTION is now terminal**, not just rejection: `stream.completion.then(finishStream, failStream)`.
- **complete-before-head** now always settles the head (200 Response with the body, or reject on error) before touching the body.
- **Head timeout** (`options.timeoutMs ?? 30000`): if the head never arrives, `failStream` rejects → the Android transport's try/catch falls back to the buffered `request`.
- **Idle timeout**: re-armed after head + on each chunk; errors the stream on a post-head stall.
- `clearTimers()` on `detach()`; a `detached` guard prevents double-close on the normal iOS path.

## Verification
`packages/ui/src/api/native-agent-stream.test.ts` (vitest, `vi.useFakeTimers()`, in-process fake agent) — **13 pass / 0 fail** (9 existing + 4 new): (1) completion resolution with no complete event terminates the stream + `listenerCount()===0`; (2) complete-before-head settles head to a closed 200 body; (3) stalled head → head promise **rejects** (fallback path); (4) post-head idle stall → body errors + listeners cleaned (closes the #12626 leak).

## N/A
Real Android device/emulator repro — N/A here (deterministic unit-level proof of the liveness contract; the on-device lock is a follow-up per the issue). UI screenshots/model-trajectory/audio — N/A (pure transport-layer stream control).
