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
automatic enrollment. The normal popup never displays or imports pairing
credentials. Its explicit Reconnect action clears extension-local suppression
and retries the native broker; a revoked browser remains blocked until the
owner resets the durable revocation in authenticated Eliza settings.

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

Safari packaging replaces the converter's generated message-echo handler with
the committed native-enrollment handler in `safari/native/`. The handler accepts
only the versioned `browser_bridge.enroll` request, limits both request and
response frames to 64 KiB, and relays over the containing app's private app-group
Unix socket using HMAC-SHA256 with a broker key held in the explicit shared
App Group container's private, fixed-name `s` file. The handler opens that file
without following symlinks and accepts only an owner-matched, mode-0600 regular
file containing exactly 32 bytes. The key itself never crosses the socket, and
the handler never logs native request or response content.

Unsigned local builds use deterministic App Group and socket names.
Development-signed builds set `ELIZA_SAFARI_SIGNING_TEAM` and
`ELIZA_SAFARI_SIGNING_IDENTITY` together. Release packaging must additionally set
`ELIZA_SAFARI_RELEASE=1`, `ELIZA_SAFARI_RELEASE_CHANNEL=app-store`, `ELIZA_SAFARI_APP_GROUP`,
`ELIZA_SAFARI_APP_PROVISIONING_PROFILE_SPECIFIER`, and
`ELIZA_SAFARI_EXTENSION_PROVISIONING_PROFILE_SPECIFIER`; missing or malformed
release signing inputs fail before conversion. Both provisioning profiles must
authorize the exact registered App Group. `ELIZA_SAFARI_BROKER_SOCKET_NAME`
overrides its deterministic default when the containing app uses a different
broker registration.
