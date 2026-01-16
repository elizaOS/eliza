# ComputerUse Bridge Extension (MV3)

Evaluates JavaScript in the active tab using Chrome DevTools Protocol without opening DevTools, bridged to a local WebSocket at `ws://127.0.0.1:17373`.

- Permissions: `debugger`, `tabs`, `scripting`, `activeTab`, `<all_urls>`
- Background service worker connects to the local WebSocket and handles `{ action: 'eval', id, code }` messages. Replies with `{ id, ok, result|error }`.

## Install (Load Unpacked)
1. Open `chrome://extensions` (or Edge: `edge://extensions`).
2. Enable Developer Mode.
3. Click "Load unpacked" and select this `browser-extension/` folder.
4. Keep the Extensions page open for easy reloading during development.

Alternatively, launch Chromium with:

```sh
chromium --load-extension=/absolute/path/to/browser-extension
```

## Protocol
- Request: `{ "id": "uuid", "action": "eval", "code": "document.title", "awaitPromise": true }`
- Response: `{ "id": "uuid", "ok": true, "result": "..." }` or `{ "id": "uuid", "ok": false, "error": "..." }`

Targets the active tab of the last focused window.