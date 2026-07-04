# Issue #13372 — iOS simulator mixed-content WebSocket fallback

Date: 2026-07-04

## Change

- `packages/ui/src/api/client-base.ts` now treats an insecure `ws://` target from
  an `https:` page origin as connected-over-REST instead of opening the socket.
- This avoids WKWebView/browser mixed-content blocking consuming all reconnect
  attempts and showing the fatal "Lost backend connection" overlay while the
  HTTP/SSE API remains reachable.
- `packages/ui/src/api/client-base-websocket.test.ts` pins the jsdom origin to
  `https://localhost/` and covers the `http://127.0.0.1:31338` agent-base case.

## Verification

- `bun run --cwd packages/ui test src/api/client-base-websocket.test.ts`
  - 1 file passed, 12 tests passed.
- `bunx @biomejs/biome check packages/ui/src/api/client-base.ts packages/ui/src/api/client-base-websocket.test.ts --no-errors-on-unmatched`
  - Passed.
- `bun run --cwd packages/ui typecheck`
  - Passed.

## Not captured

- Real iOS simulator walkthrough/video was not captured in this local pass. The
  code path is covered by the HTTPS-origin WebSocket unit regression; mobile
  smoke evidence should be captured before merging if a simulator is available.
