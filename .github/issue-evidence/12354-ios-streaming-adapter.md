# #12354 — iOS local-agent streaming adapter for the Bun runtime bridge

Phase-2 item 5 of #12180. Adds incremental chat-token streaming to the iOS
full-Bun runtime bridge so `POST /api/conversations/:id/messages/stream` renders
token-by-token on iOS local mode instead of the buffered single-frame SSE.

## What changed

| Layer | File | Change |
| --- | --- | --- |
| Bridge JS | `plugins/plugin-capacitor-bridge/src/ios/bridge.ts` | `http_request_stream` NDJSON method; `streamConversationMessageResponse` emits response head → one base64 SSE `token` chunk per model token (running `fullText`) → `complete`, each via a `stream_emit` host-call; `handleDirectConversationMessage` / `maybeGenerateIosNativeConversationReply` gain an `onToken` hook. `bufferedConversationStreamResponse` stays only as the buffered fallback. |
| Native (Swift) | `.../FullBunEngineHost.swift` | `stream_emit` host-call case → `streamEventSink` → `agentStreamResponse`/`agentStreamChunk`/`agentStreamComplete` Capacitor events (Android contract). Added to the host-call allowlist. |
| Native (Swift) | `.../ElizaBunRuntimePlugin.swift` | Wires `streamEventSink` to `notifyListeners` in `load()`. |
| Plugin types | `plugins/plugin-native-bun-runtime/src/definitions.ts` | Declares `addListener` + `AgentStreamEventName` on the plugin surface. |
| Contract | `packages/native/bun-runtime/BRIDGE_CONTRACT.md` | Documents `http_request_stream` + `stream_emit`. |
| TS adapter | `packages/ui/src/api/ios-streaming-agent-plugin.ts` | `createIosStreamingAgentPlugin(runtime)` satisfies `NativeStreamingAgentPlugin` so `createNativeStreamingResponse` is used unmodified. Pre-allocates `streamId`, returns it synchronously, fires the blocking native call in the background (the native call blocks until the stream ends — listeners must be live first). |
| TS transport | `packages/ui/src/api/ios-local-agent-transport.ts` + `packages/app-core/src/api/ios-local-agent-transport.ts` (mirror) | Route `isStreamingRequest` requests through the streaming adapter; buffered path is the fallback. |

## Design note — why the native call is fire-and-forget

The embedded Bun engine's C ABI (`eliza_bun_engine_call`) is a single
request→single response call that holds `g_call_mutex` for the whole call and
services the per-token `stream_emit` host-calls **inline** while it waits
(`packages/native/bun-runtime/Sources/ElizaBunEngineShim/eliza_bun_engine_shim.c`).
So a `call({method:"http_request_stream"})` blocks until the stream completes,
but the token events reach the WebView **live** via `notifyListeners` during the
call. The TS adapter therefore returns the pre-allocated `streamId`
synchronously and fires the blocking call in the background, so the caller's
`agentStream*` listeners are attached before any event fires (asserted in the
adapter test).

## Verification — done this session (real, headless)

- **Bridge streaming unit tests** — `plugins/plugin-capacitor-bridge/src/ios/bridge.stream.test.ts`
  (7 tests, deterministic fake emitter + fake runtime, no device): head → one
  chunk per token with running `fullText` → complete; >1 chunk per turn; 404 for
  unknown conversation; graceful failure still terminates; `fetchBackendStream`
  routing; unsafe-path rejection. Output: `12354-bridge-stream-test.txt`.
- **iOS streaming adapter unit tests** — `packages/ui/src/api/ios-streaming-agent-plugin.test.ts`
  (4 tests): `NativeStreamingAgentPlugin` type-guard; synchronous `streamId` +
  arg forwarding; **token-by-token through `createNativeStreamingResponse` with
  a listeners-attached-before-emit assertion**; `onStreamError` on call
  rejection. Output: `12354-adapter-test.txt`.
- **Regression** — `plugin-capacitor-bridge` `bridge.routes.test.ts` (15) +
  `shared/stdio-bridge.test.ts` (7) stay green; `packages/ui`
  `android-native-agent-transport.test.ts` + `client-agent-stream.test.ts` stay
  green (27 total with the adapter suite).
- **Typecheck** — `plugin-native-bun-runtime`, `packages/ui`,
  `packages/app-core` `tsgo --noEmit` clean for all touched files. (The repo's
  worktree ships `src/i18n/generated/*` as a build-time codegen artifact; it was
  generated locally via `packages/shared/scripts/generate-keywords.mjs` so tests
  run — those generated files are gitignored and not part of this PR.)
- **Lint** — Biome clean on every touched file (one pre-existing import-sort
  finding in `bridge.ts` predates this branch and is on an import block this PR
  does not modify).

## Verification — NOT done this session (honest N/A)

- **`bun run --cwd packages/app capture:ios-sim` with token-by-token recording /
  device console `agentStreamChunk` logs** — **N/A this session.** A genuine
  on-device capture requires building `ElizaBunEngine.xcframework` (the iOS Bun
  fork — the shipped `artifacts/ElizaBunEngine.xcframework` here carries only
  `Info.plist`, no compiled slices) and rebuilding + reinstalling the Capacitor
  app with the Swift changes and a loaded on-device model. That engine build is a
  multi-hour toolchain build not feasible in this session's budget; the app
  currently installed on the booted iPhone 16 Pro simulator is a stale build
  without these changes, so screenshotting it would prove nothing (per
  `PR_EVIDENCE.md`). The streaming logic is instead proven by the deterministic
  unit tests above, which drive the exact `agentStream*` frame contract the
  device path emits. **The Swift changes compile-check only in the iOS build**
  (no standalone `swiftc` — they import `Capacitor` / `ElizaBunEngine`); brace/
  paren balance verified, helper symbols (`stringValue`/`intValue`/
  `stringMapValue`/`notifyListeners`) confirmed present.
