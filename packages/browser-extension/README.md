# `@elizaos/browser-bridge-extension`

The browser bridge extension pairs a user's personal browser profile with an
Eliza agent so the agent can read the current page and run owner-approved
browser actions.

## What it does

Once installed and paired, the extension:

- Syncs open tabs and the current page's text/links/forms to the Eliza agent every 30 seconds and on every tab change.
- Executes agent-directed browser actions: open a URL, navigate, click an element, type into a field, submit a form, scroll history, or focus a tab.
- Injects a wallet shim into allowlisted pages so dapp interactions can be routed through the agent's wallet.
- Enforces an agent-configured website blocklist using the browser's `declarativeNetRequest` API.

## Supported browsers

| Browser | Build target |
|---|---|
| Chrome / Chromium / Edge | `bun run build:chrome` → `dist/chrome/` |
| Safari (macOS / iOS) | `bun run build:safari-webextension` → `dist/safari/`, then packaged with Xcode |

## Security model

**Host allowlist (default install)**

The extension ships with a scoped host allowlist instead of a blanket `<all_urls>` grant. The default-install hosts are:

- `https://eliza.how/*` and subdomains
- `https://eliza.dev/*` and subdomains

Content scripts and the wallet shim auto-inject only on these origins.

**Optional hosts**

If a user wants the agent to read or act on an additional site, the extension
requests permission at runtime via `chrome.permissions.request`. An in-product
approval prompt confirms the exact origin before any script is injected.

**Content Security Policy**

`script-src 'self'; object-src 'self'` is enforced on extension pages. Inline
scripts are forbidden; only first-party bundle code may execute. No
`unsafe-eval` and no `wasm-unsafe-eval`.

**Threat model boundaries**

- Out of scope: keylogging, password harvesting, generic content extraction beyond allowlisted hosts.
- In scope: agent-directed `click`, `type`, `submit`, `history_back`, `history_forward` actions on allowlisted pages; wallet-shim isolation for crypto requests.

## Pairing

The extension connects to a running Eliza agent API server (default `http://127.0.0.1:31337`).

**Auto-pair (recommended):** Open the Eliza web app in the same browser profile, then open the extension popup and click **Auto Connect This Browser**. The extension scans open tabs for a live agent and pairs automatically.

**Manual pair:** Obtain a pairing JSON object from the Eliza agent's Browser settings, paste it into the popup's Advanced Tools section, and click **Import**.

## Development

```bash
# Install dependencies
bun install --cwd packages/browser-bridge-extension

# Build Chrome extension
bun run --cwd packages/browser-bridge-extension build:chrome

# Load in Chrome: chrome://extensions → Developer mode → Load unpacked → select dist/chrome/

# Run unit tests
bun run --cwd packages/browser-bridge-extension test

# Smoke-check the built artifact
bun run --cwd packages/browser-bridge-extension test:smoke
```

## Packaging for distribution

```bash
bun run --cwd packages/browser-bridge-extension package:chrome   # → ZIP for Chrome Web Store
bun run --cwd packages/browser-bridge-extension package:safari   # → xcrun Safari Web Extension
bun run --cwd packages/browser-bridge-extension package:release  # → all formats
```
