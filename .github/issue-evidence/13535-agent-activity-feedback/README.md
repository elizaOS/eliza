# #13535 — rich agent-activity feedback (working indicator + inline tool calls)

Follow-up to #8813. Two of the three surfaces the issue asks for ship here, end
to end and driven by **real agent stream events**:

1. **Codex-style working indicator** — `TurnStatus` now renders a spinner glyph,
   a word for every phase (including `thinking`, previously dots-only), and a
   live elapsed-seconds clock ("Thinking · 4s", "Using Web search · 12s").
2. **Inline tool-call status** — the runtime's native planner/tool stream
   (`tool_call` / `tool_result` / `tool_error`, forwarded through
   `onStreamChunk` in `packages/core/src/services/message.ts`) is forked onto an
   additive `type: "tool"` chat SSE frame, parsed by the client, accumulated
   per-turn by `callId`, and rendered inline in the thread with the existing
   `ToolCallEventLog` (running → success/failure, args/result previews).

Additive contract: a client that ignores the new `tool` frames behaves exactly
as before.

## Screenshots (real pixels, the shipping components)

`states-desktop.png` / `states-mobile.png` — captured by
`bun run --cwd packages/ui test:activity-feedback-e2e`, which esbuild-bundles the
REAL `TurnStatus` + `ToolCallEventLog` and screenshots them in headless Chromium
across the three turn states:

- **Thinking** — spinner + "Thinking · 2s".
- **Running a tool** — "Using Web search · 2s" status line + an inline
  `WEB_SEARCH` row in the **RUNNING** state (orange accent).
- **Settled** — the same row flipped to **SUCCESS** (green) with args + result,
  followed by the reply text.

Orange is accent-only (the RUNNING pill); success is green, failure red; no blue.

## Tests (real path, both ends)

- `packages/agent/src/api/chat-tool-sse.test.ts` — drives the real
  `chatEventsFromStructuredStreamPayload` projection with the **exact** payload
  shapes `services/message.ts` forwards (tool_call/tool_result/tool_error/
  evaluation), and `writeChatToolSse`'s single additive frame. 10 tests.
- `packages/ui/src/api/client-agent-stream.test.ts` — SSE round-trip:
  `call` → `result` correlated by `callId` reaches `onToolEvent`; a malformed
  frame (missing `callId` / unknown phase) is dropped without crashing. Additive
  status/token/done behaviour unchanged.
- `packages/ui/src/components/tool-events/chat-tool-events.test.ts` +
  `packages/ui/src/state/useStreamingText.tool.test.ts` — the merge-by-callId
  fold and the `mode: "tool"` reducer modification (running → settled in place,
  no-op for unknown id).
- `packages/ui/src/components/composites/chat/chat-typing-indicator.test.tsx` —
  the elapsed clock + `thinking` label + spinner.

## Pending — live booted-agent trajectory

The one leg not captured here is a full end-to-end trajectory from a **booted
agent** replying with a real tool call, streamed over SSE into the running UI —
it needs a running agent stack plus a tool-capable provider. The code path is
complete and proven at both ends (the backend projection is tested against the
literal runtime payload shapes it consumes; the client parse is round-trip
tested). Capture on a stack with a live provider + a tool plugin (e.g.
`WEB_SEARCH`) via `packages/scenario-runner/bin/eliza-scenarios`.

## Not in this PR — streamed native reasoning (issue part 2)

The issue's part 2 (streaming the model's reasoning live into an auto-collapsing
`ThinkingBlock`) is deliberately not included: it requires a new reasoning
channel through the frozen core model-stream contracts + provider capture
(Anthropic extended thinking / OpenAI `reasoningSummary`). Reasoning already
renders post-turn today (`message.reasoning` from the `done` event), and the
live "thinking" phase is now covered by the working indicator above. The
additive `reasoning` SSE event is left for a focused follow-up so this PR does
not destabilise the core message loop.
