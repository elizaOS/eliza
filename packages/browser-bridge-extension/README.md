# `@elizaos/browser-bridge-extension`

The browser bridge extension pairs a user's personal browser profile with an
Eliza agent so the agent can read the current page and run owner-approved
browser actions.

## What it does

Once installed and paired, the extension:

- Syncs open tabs and the current page's text/links/forms to the Eliza agent every 30 seconds and on every tab change.
- Executes agent-directed browser actions: open a URL, navigate, click an element, type into a field, submit a form, scroll history, or focus a tab.
- Enforces an agent-configured website blocklist using the browser's `declarativeNetRequest` API.

## Supported browsers

| Browser | Build target |
|---|---|
| Chrome / Chromium / Edge | `bun run build:chrome` → `dist/chrome/` |
| Firefox | `bun run build:firefox` → `dist/firefox/` |
| Safari (macOS / iOS) | `bun run build:safari-webextension` → `dist/safari/`, then packaged with Xcode |

## Security model

**Host allowlist (default install)**

The extension ships with a scoped host allowlist instead of a blanket `<all_urls>` grant. The default-install hosts are:

- `http://127.0.0.1/*` and `http://localhost/*` for the local agent API

The page-capture content script auto-injects only on these origins. No wallet
shim ships in the store artifact: a signing token must never be injected into
every allowlisted origin or child frame. Wallet injection remains out of scope
until an explicit top-frame origin grant is wired and reviewed end to end.

Blocked-site entries are host-scoped: blocking a host also blocks its
subdomains across HTTP(S) schemes and ports. Website grants remain exact
origins and still require the browser's own effective host permission.

**Optional hosts**

If a user wants the agent to read or act on an additional site, the extension
uses the browser's extension site-access controls to grant the exact origin.
The sync and action paths independently check the browser's effective grants
before sharing tab metadata or executing a browser action.

**Content Security Policy**

`script-src 'self'; object-src 'self'` is enforced on extension pages. Inline
scripts are forbidden; only first-party bundle code may execute. No
`unsafe-eval` and no `wasm-unsafe-eval`.

**Threat model boundaries**

- Out of scope: keylogging, password harvesting, generic content extraction beyond allowlisted hosts.
- In scope: agent-directed `click`, `type`, `submit`, `history_back`, and `history_forward` actions on allowlisted pages.

## Pairing

The extension connects to a running Eliza agent API server (default `http://127.0.0.1:31337`).

On startup and before sync, the extension asks the registered
`ai.elizaos.browserbridge` native-messaging host for a short-lived companion
credential. The desktop broker authenticates the current OS user and is the
authority for the API origin and credential. A loopback page or server cannot
enroll an extension. Explicit disconnects and server revocations suppress
automatic enrollment until the owner imports a new authenticated pairing.

Manual recovery remains available: create a browser companion pairing from
authenticated Eliza Browser settings, copy its pairing JSON, paste it into
**Pairing and Advanced Tools**, and click **Import Pairing JSON**.

### Stable extension IDs

Native-host installers must allow only the exact released extension identity;
wildcard origins and development IDs are forbidden.

- Chrome-family releases must retain the same Web Store identity (or the same
  committed manifest public key) and register only its exact
  `chrome-extension://<id>/` origin. Never distribute the private signing key.
- Firefox uses the manifest ID `browser-bridge@elizaos.ai`; its native-host
  manifest must list only that exact extension ID.
- Safari native messaging is supplied by the signed containing app. Its bundle
  and app-group identities must match the release signing configuration.

Unpacked Chrome builds without the release public key have profile-local IDs
and intentionally cannot use a production native-host registration. Register a
separate exact development ID when testing locally.

The retired `/api/browser-bridge/companions/auto-pair` compatibility endpoint returns `410 Gone` and never mints credentials. Loopback reachability and an extension `Origin` are not proof of owner authorization.

## Development

```bash
# Install dependencies
bun install --cwd packages/browser-bridge-extension

# Build Chrome extension
bun run --cwd packages/browser-bridge-extension build:chrome

# Build Firefox extension
bun run --cwd packages/browser-bridge-extension build:firefox

# Load in Chrome: chrome://extensions → Developer mode → Load unpacked → select dist/chrome/

# Run CI-safe unit tests
bun run --cwd packages/browser-bridge-extension test

# Explicitly run the installed Chrome and Firefox acceptance lanes
bun run --cwd packages/browser-bridge-extension test:smoke:installed

# Smoke-check an installed Chrome-family extension
bun run --cwd packages/browser-bridge-extension test:smoke

# Package, install, and exercise the extension in Firefox over WebDriver BiDi
bun run --cwd packages/browser-bridge-extension test:smoke:firefox
```

The Firefox smoke uses the system Firefox application. Set
`FIREFOX_EXECUTABLE_PATH` when Firefox is not installed in its standard macOS,
Linux, or Windows location.

## Packaging for distribution

```bash
bun run --cwd packages/browser-bridge-extension package:chrome   # → ZIP for Chrome Web Store
bun run --cwd packages/browser-bridge-extension package:firefox  # → deterministic ZIP + XPI for AMO/self-hosting
bun run --cwd packages/browser-bridge-extension package:safari   # → xcrun Safari Web Extension
bun run --cwd packages/browser-bridge-extension package:release  # → all formats
```
