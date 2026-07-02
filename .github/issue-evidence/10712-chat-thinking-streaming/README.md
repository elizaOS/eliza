# #10712 — chat streaming tokens + Thinking disclosure

## What This Proves

- `packages/agent/src/api/__tests__/conversation-stream-provider-parity.test.ts`
  drives the real `POST /api/conversations/:id/messages/stream` route with
  `generateChatResponse` intact. The same deterministic `runtime.useModel`
  fixture passes through both provider profiles:
  - `local-inference`
  - `cloud-resolved`
- The route emits ordered SSE frames:
  - `{ type: "status", kind: "thinking" }`
  - ordered `{ type: "token", text, fullText }`
  - terminal `{ type: "done", fullText, thought }`
- `packages/ui/src/components/chat/ThinkingBlock.test.tsx` covers:
  collapsed by default, toggle behavior, empty/whitespace null render, and
  accent-only/no-blue styling.
- `packages/ui/src/components/shell/ContinuousChatOverlay.test.tsx` covers the
  reducer-to-overlay path: streamed text appears incrementally, reasoning is
  suppressed while the final assistant turn is still streaming, and Thinking
  appears collapsed after completion.
- `packages/app/test/ui-smoke/chat-streaming-thinking.spec.ts` records the real
  app overlay at desktop and mobile sizes using a deterministic streaming
  `ReadableStream` response.

## Evidence Artifacts

- Desktop screenshots:
  - `desktop-mid-stream.png`
  - `desktop-thinking-collapsed.png`
  - `desktop-thinking-expanded.png`
- Mobile screenshots:
  - `mobile-mid-stream.png`
  - `mobile-thinking-collapsed.png`
  - `mobile-thinking-expanded.png`
- Video walkthroughs:
  - `desktop-streaming-thinking.webm`
  - `mobile-streaming-thinking.webm`
- Browser traces:
  - `desktop-trace.zip`
  - `mobile-trace.zip`
- Frontend event/console logs:
  - `desktop-streaming-events.json`
  - `mobile-streaming-events.json`
  - `desktop-console.log`
  - `mobile-console.log`

## Commands Run

- `bun run --cwd packages/agent test -- src/api/__tests__/conversation-stream-provider-parity.test.ts --coverage.enabled=false`
- `bun run --cwd packages/ui test -- src/components/chat/ThinkingBlock.test.tsx src/components/shell/ContinuousChatOverlay.test.tsx --coverage.enabled=false`
- `E2E_RECORD=1 ELIZA_UI_SMOKE_PORT=2182 ELIZA_UI_SMOKE_API_PORT=31382 ELIZA_API_PORT=31382 bunx playwright test --config packages/app/playwright.ui-smoke.config.ts packages/app/test/ui-smoke/chat-streaming-thinking.spec.ts --project=chromium`
- `bunx biome check packages/app/test/ui-smoke/chat-streaming-thinking.spec.ts packages/ui/src/components/chat/ThinkingBlock.tsx packages/ui/src/components/chat/ThinkingBlock.test.tsx packages/ui/src/components/shell/ContinuousChatOverlay.tsx packages/ui/src/components/shell/ContinuousChatOverlay.test.tsx packages/agent/src/api/__tests__/conversation-stream-provider-parity.test.ts`
- `bun run --cwd packages/ui typecheck`

## Manual Review

- Desktop mid-stream: good — first token is visible while the assistant turn is
  still in progress.
- Desktop collapsed/expanded Thinking: good — disclosure is collapsed by
  default and readable when expanded.
- Mobile mid-stream: good — partial token state fits without overlap.
- Mobile collapsed/expanded Thinking: good — disclosure and reasoning text fit
  inside the mobile chat sheet.
- Frontend console/event logs: good — service worker, renderer build, shell
  mode, streaming request payload, and ordered SSE frames are captured with no
  uncaught page errors.

## Typecheck Notes

- `packages/ui` typecheck passes.
- `packages/app` typecheck remains blocked by pre-existing unresolved workspace
  modules: `@elizaos/app-core`, `@elizaos/capacitor-mobile-agent-bridge`, and
  `@elizaos/tui`.
- `packages/agent` typecheck remains blocked by pre-existing unresolved
  workspace modules: `@elizaos/plugin-streaming`,
  `@elizaos/plugin-background-runner`, and `@elizaos/cloud-routing`.

## N/A

- Real live-model trajectory: N/A for this PR because it adds deterministic
  coverage for an existing streaming/thinking contract and does not change
  prompt/model behavior. The mock `runtime.useModel` fixture is intentionally
  the thing under test for #10712.
- iOS/Android native capture: N/A — renderer + API/runtime behavior, no
  native bridge surface changed.
