# @elizaos/browser-bridge-extension

Browser extension (Chrome + Safari) that pairs a user's browser profile with an Eliza agent so the agent can read open tabs and execute owner-approved browser actions.

## Purpose / role

This is a standalone browser extension — it is not a Node/Bun package imported by other packages. It exposes no npm exports. It communicates with the elizaOS agent API server (default `http://127.0.0.1:31337`) over HTTP using a companion pairing token. The corresponding server-side routes live in `packages/app-core/src/api/` under the `/api/browser-bridge/` prefix. The `@elizaos/shared` package provides shared types consumed by both sides (`LifeOpsBrowserSession`, `LifeOpsBrowserCompanionSyncResponse`, etc.).

## Layout

```
packages/browser-bridge-extension/
  entrypoints/
    background.ts     Service worker: sync loop, auto-pair, session execution, website blocker
    content.ts        Content script injected into allowlisted pages: page capture + DOM actions
    popup.ts          Extension popup UI controller
    blocked.ts        Redirect target page shown when a site is blocked
    wallet-shim.ts    Content script (document_start): injects EVM/Solana wallet shim into page JS context
  src/
    protocol.ts               Internal message types (PopupRequest/Response, ContentScriptMessage, BackgroundState, etc.)
    browser-bridge-contracts.ts  Public data contracts: BrowserBridgeSettings, BrowserBridgeAction, SyncBrowserBridgeStateRequest, etc.
    api-client.ts             BrowserBridgeRelayClient — typed HTTP client for companion sync/session endpoints
    storage.ts                chrome.storage.local wrappers; companion config persistence; agent API auto-discovery
    tab-cache.ts              Tab merge/filter logic; selectTabsForSync; findFocusedTab
    page-extract.ts           capturePageContext() — collects title, text, headings, links, forms from the live DOM
    dom-actions.ts            runDomAction() — executes click/type/submit/history_back/history_forward in page
    popup-model.ts            derivePopupStatusModel() — pure status model for popup rendering
    webextension.ts           Thin promise wrapper over chrome.* / browser.* APIs (storage, tabs, windows, alarms, scripting, permissions, declarativeNetRequest)
    url.ts                    normalizeHttpBaseUrl, normalizeHttpOrigin helpers
  scripts/
    build.mjs                 Bun build script; produces IIFE bundles + manifest.json in dist/<chrome|safari>/
    package-chrome.mjs        Packages dist/chrome into a .zip for Chrome Web Store
    package-safari.mjs        Invokes xcrun to wrap dist/safari into a Safari Web Extension
    package-stores.mjs        Packages store asset screenshots/descriptions
    package-release.mjs       Orchestrates all packaging steps
    extension-smoke.mjs       Node smoke test for Chrome build artifacts
    extension-smoke-safari.mjs  Node smoke test for Safari build artifacts
    release-version.mjs       Version helpers (semver → Chrome 4-part version)
    script-utils.mjs          Shared build script utilities
  public/
    popup.html / popup.css    Extension popup page
    blocked.html              Website-blocker redirect page
    icons/                    icon16.png, icon32.png, icon128.png
  safari/                     Xcode project wrapper for Safari Web Extension packaging
  vitest.extension.config.ts  Vitest config for src/ unit tests
  dist/                       Build output (gitignored); dist/chrome/, dist/safari/
```

## Key internal modules

| Module | Role |
|---|---|
| `src/protocol.ts` | All runtime message types between extension contexts (popup ↔ background, background ↔ content) |
| `src/browser-bridge-contracts.ts` | Data types shared between extension and the agent API (`BrowserBridgeSettings`, `BrowserBridgeAction`, sync request/response shapes) |
| `src/api-client.ts` | `BrowserBridgeRelayClient` — calls `/api/browser-bridge/companions/sync`, `/progress`, `/complete` with Bearer pairing token |
| `src/storage.ts` | Config persistence in `chrome.storage.local`; loopback discovery of agent API (`http://127.0.0.1:31337` default) |
| `src/webextension.ts` | Normalizes `chrome.*` / `browser.*` API differences; all extension API calls go through here |

## Build constants

The build script (`scripts/build.mjs`) injects two define constants into each bundle:

- `__BROWSER_BRIDGE_KIND__`: `"chrome"` or `"safari"` (set by `bun run build:chrome` vs `build:safari-webextension`)
- `__WALLET_SHIM_TEMPLATE__`: raw JS template loaded from `plugins/plugin-wallet/src/browser-shim/shim.template.js`

## Extension entrypoints and manifest

`scripts/build.mjs` produces `dist/<kind>/manifest.json` at build time. Key manifest fields:

- `permissions`: `tabs`, `storage`, `scripting`, `alarms`, `activeTab`, `declarativeNetRequest`, `declarativeNetRequestWithHostAccess`
- `host_permissions` (default install): `https://eliza.how/*`, `https://*.eliza.how/*`, `https://eliza.dev/*`, `https://*.eliza.dev/*`
- `optional_host_permissions`: `https://*/*`, `http://*/*` — granted at runtime per user confirmation
- `content_security_policy`: `script-src 'self'; object-src 'self'` — no inline scripts, no `unsafe-eval`
- Service worker: `background.js` (built from `entrypoints/background.ts`)
- Content scripts at `document_idle`: `content.js` (page capture + DOM actions), injected only on allowlisted hosts
- Content scripts at `document_start`: `wallet-shim.js`, all frames on allowlisted hosts

## Commands

All scripts are run from the package directory:

```bash
bun run --cwd packages/browser-bridge-extension build                   # Chrome (default)
bun run --cwd packages/browser-bridge-extension build:chrome
bun run --cwd packages/browser-bridge-extension build:safari-webextension
bun run --cwd packages/browser-bridge-extension package:chrome          # .zip for Chrome Web Store
bun run --cwd packages/browser-bridge-extension package:safari
bun run --cwd packages/browser-bridge-extension package:stores
bun run --cwd packages/browser-bridge-extension package:release
bun run --cwd packages/browser-bridge-extension test                    # vitest unit tests (src/)
bun run --cwd packages/browser-bridge-extension test:smoke              # smoke-checks Chrome dist artifacts
bun run --cwd packages/browser-bridge-extension test:smoke:safari
bun run --cwd packages/browser-bridge-extension test:ci                 # test + test:smoke
```

Output lands in `dist/chrome/` or `dist/safari/`. Load `dist/chrome/` as an unpacked extension in Chrome DevTools for local dev.

## Agent API endpoints the extension calls

All calls use `Authorization: Bearer <pairingToken>` and `X-Browser-Bridge-Companion-Id: <companionId>`.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/browser-bridge/companions/auto-pair` | Zero-config pairing when Eliza is open in the same browser |
| `POST` | `/api/browser-bridge/companions/sync` | Heartbeat: posts tab snapshot + page context; receives settings + optional session |
| `POST` | `/api/browser-bridge/companions/sessions/:id/progress` | Reports completed action step |
| `POST` | `/api/browser-bridge/companions/sessions/:id/complete` | Marks session done or failed |
| `GET` | `/api/website-blocker` | Fetches active blocked/allowed site lists for declarativeNetRequest rules |
| `GET` | `/api/status` | Used by auto-discovery to confirm a loopback address is a live agent |

## Browser actions the extension can execute

Triggered by `BrowserBridgeAction` objects delivered in the sync response's `session.actions` array:

`open`, `navigate`, `focus_tab`, `back`, `forward`, `reload` — handled in the service worker via `chrome.tabs.*`

`click`, `type`, `submit`, `history_back`, `history_forward` — handled by `runDomAction()` in the content script via `browser-bridge:execute-dom-action` message

`read_page`, `extract_links`, `extract_forms` — handled by `capturePageContext()` in the content script via `browser-bridge:capture-page` message

## Config / env

No environment variables. Configuration is stored in `chrome.storage.local` under two keys:

- `browserBridgeCompanionConfig` — `CompanionConfig` (apiBaseUrl, companionId, pairingToken, browser, profileId, profileLabel, label)
- `browserBridgeBackgroundState` — `BackgroundState` (persisted across service worker restarts)

Default `apiBaseUrl` is `http://127.0.0.1:31337`. Auto-discovery also probes `http://127.0.0.1:2138`, `http://localhost:2138`, `http://localhost:31337`.

## How to extend

**Add a new DOM action kind:**
1. Add the kind to `DomActionRequest["kind"]` union in `src/protocol.ts`.
2. Add a case in `runDomAction()` in `src/dom-actions.ts`.
3. Add the same kind to `BrowserBridgeActionKind` in `src/browser-bridge-contracts.ts`.
4. Handle it in `executeAction()` in `entrypoints/background.ts` if it requires tab-level orchestration rather than in-page execution.

**Add a new popup message type:**
1. Add to the `PopupRequest` union in `src/protocol.ts`.
2. Add a case in `handlePopupMessage()` in `entrypoints/background.ts`.
3. Wire the button/handler in `entrypoints/popup.ts`.

**Expand the host allowlist at build time:**
Edit `BROWSER_BRIDGE_HOST_ALLOWLIST` in `scripts/build.mjs`. The array is mirrored into `host_permissions` and `content_scripts.matches` in the generated manifest.

## Conventions / gotchas

- The extension has no npm exports and is `"private": true`. Nothing imports from it via package resolution.
- `src/webextension.ts` normalizes `chrome.*` / `browser.*` differences. All extension API calls must go through this module — never call `chrome.*` or `browser.*` directly from other src files.
- The wallet shim is injected at `document_start` and runs before page JS. Its template is baked into the bundle at build time from `plugins/plugin-wallet/src/browser-shim/shim.template.js`. Missing that file will cause the build to fail.
- Sync runs on a 30-second alarm (`SYNC_INTERVAL_MINUTES = 0.5`) and is debounced 750ms after tab events. Do not remove the debounce — rapid tab events would otherwise flood the agent API.
- `isCompanionAuthError()` in the background detects expired/revoked pairing tokens and clears stored config so the next sync triggers auto-pair automatically.
- Unit tests in `src/storage.test.ts` use `jsdom` via `vitest.extension.config.ts`. Do not run `bun test` from the repo root for this package — it uses its own vitest config.
