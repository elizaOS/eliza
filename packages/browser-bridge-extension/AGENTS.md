# @elizaos/browser-bridge-extension

Browser extension for Chrome-family browsers, Firefox, and Safari that pairs a user's browser profile with an Eliza agent so the agent can read open tabs and execute owner-approved browser actions.

## Purpose / role

This is a standalone browser extension — it is not a Node/Bun package imported by other packages. It exposes no npm exports. It communicates with the elizaOS agent API server (default `http://127.0.0.1:31337`) over HTTP using a companion pairing token. The corresponding `/api/browser-bridge/*` server-side routes live in `plugins/plugin-browser/src/routes/bridge.ts`; the `/api/website-blocker` route is served by `plugins/plugin-native-websiteblocker`. Extension-local wire types mirror the owning plugin contracts so this standalone workspace does not depend on runtime packages.

## Layout

```
packages/browser-bridge-extension/
  entrypoints/
    background.ts     Service worker: sync loop, session execution, website blocker
    content.ts        Content script injected into allowlisted pages: page capture + DOM actions
    popup.ts          Extension popup UI controller
    blocked.ts        Redirect target page shown when a site is blocked
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
    build.mjs                 Bun build script; produces IIFE bundles + manifest.json in dist/<chrome|firefox|safari>/
    package-webextension.mjs  Deterministic ZIP/XPI packager shared by Chrome and Firefox
    package-chrome.mjs        Packages dist/chrome into a .zip for Chrome Web Store
    package-firefox.mjs       Packages dist/firefox into reproducible .zip and .xpi artifacts
    package-safari.mjs        Invokes xcrun to wrap dist/safari into a Safari Web Extension
    package-store-assets.mjs  Packages store asset screenshots/descriptions
    package-release.mjs       Orchestrates all packaging steps
    extension-smoke.mjs       Installed Chrome smoke plus reusable local agent harness
    extension-smoke-firefox.mjs Firefox artifact and installed-browser WebDriver BiDi smoke
    extension-smoke-safari.mjs  Node smoke test for Safari build artifacts
    release-version.mjs       Version helpers (semver → Chrome 4-part version)
    script-utils.mjs          Shared build script utilities
  public/
    popup.html / popup.css    Extension popup page
    blocked.html              Website-blocker redirect page
    icons/                    Optional development overrides; release icons come from packages/shared assets
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

The build script (`scripts/build.mjs`) injects one define constant into each bundle:

- `__BROWSER_BRIDGE_KIND__`: `"chrome"`, `"firefox"`, or `"safari"` (selected by the corresponding build script)

## Extension entrypoints and manifest

`scripts/build.mjs` produces `dist/<kind>/manifest.json` at build time. Key manifest fields:

- `permissions`: `tabs`, `storage`, `scripting`, `alarms`, `activeTab`, `declarativeNetRequestWithHostAccess`
- `host_permissions` (default install): `http://127.0.0.1/*` and `http://localhost/*` for background-owned local-agent discovery
- `optional_host_permissions`: `https://*/*`, `http://*/*` — requested only from the popup's browser-managed **Grant Website Access** action
- `content_security_policy`: `script-src 'self'; object-src 'self'` — no inline scripts, no `unsafe-eval`
- Background entrypoint: MV3 service worker on Chrome/Safari and a background script on Firefox
- Content scripts at `document_idle`: `content.js` (page capture + DOM actions), injected only on allowlisted hosts
- No wallet shim is emitted. A future wallet injection path requires a
  separately reviewed, explicit top-frame origin grant before any signing code
  may enter the store artifact.

## Commands

All scripts are run from the package directory:

```bash
bun run --cwd packages/browser-bridge-extension build             # Chrome (default)
bun run --cwd packages/browser-bridge-extension build:chrome
bun run --cwd packages/browser-bridge-extension build:firefox
bun run --cwd packages/browser-bridge-extension build:safari-webextension
bun run --cwd packages/browser-bridge-extension clean             # remove dist/
bun run --cwd packages/browser-bridge-extension typecheck
bun run --cwd packages/browser-bridge-extension lint:check
bun run --cwd packages/browser-bridge-extension format:check
bun run --cwd packages/browser-bridge-extension package:chrome
bun run --cwd packages/browser-bridge-extension package:firefox
bun run --cwd packages/browser-bridge-extension package:safari
bun run --cwd packages/browser-bridge-extension package:stores
bun run --cwd packages/browser-bridge-extension package:release
bun run --cwd packages/browser-bridge-extension test               # test:unit only; CI-safe
bun run --cwd packages/browser-bridge-extension test:unit
bun run --cwd packages/browser-bridge-extension test:smoke:installed
bun run --cwd packages/browser-bridge-extension test:smoke
bun run --cwd packages/browser-bridge-extension test:smoke:site-access
bun run --cwd packages/browser-bridge-extension test:smoke:firefox
bun run --cwd packages/browser-bridge-extension lint:firefox
bun run --cwd packages/browser-bridge-extension test:smoke:safari
```

Output lands in `dist/chrome/`, `dist/firefox/`, or `dist/safari/`. Load the Chrome directory from `chrome://extensions`; load the Firefox directory temporarily from `about:debugging#/runtime/this-firefox`.

The extension opens its pairing guide once on a fresh browser profile so the owner can import credentials without relying on a background-page debug target. The Chrome and Firefox smokes install the unpacked build into the system browser and exercise authenticated manual pairing, explicit website access, sync, a real DOM action, progress, completion, and website-block redirect. Set `FIREFOX_EXECUTABLE_PATH` when Firefox is not installed in a standard platform location.

Chrome 137 and later reject `--load-extension` in the branded browser. Chrome smokes therefore require an official Chrome for Testing executable through `CHROME_FOR_TESTING_EXECUTABLE_PATH` (or the standard `/Applications/Google Chrome for Testing.app` path on macOS). The default `test` script runs `test:unit` only, because the `client` repository test lane must pass on machines without an installed browser; `test:smoke:installed` chains the Chrome and Firefox installed-browser smokes and is an explicit opt-in. `test:smoke` runs the loopback pairing/action contract headlessly. `test:smoke:site-access` runs headed and waits up to two minutes for the browser-managed optional-permission decision before proving the website-block redirect; it is the installed-browser acceptance lane and cannot be replaced by a headless result.

## Agent API endpoints the extension calls

All calls use `Authorization: Bearer <pairingToken>` and `X-Browser-Bridge-Companion-Id: <companionId>`.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/browser-bridge/companions/auto-pair` | Retired compatibility endpoint; returns `410 Gone` without minting credentials |
| `POST` | `/api/browser-bridge/companions/preflight` | Authenticated companion/settings-version staleness check before a sync heartbeat |
| `POST` | `/api/browser-bridge/companions/sync` | Heartbeat: posts tab snapshot + page context; receives settings + optional session |
| `POST` | `/api/browser-bridge/companions/sessions/:id/actions/begin` | Claims the durable, exact action-attempt lease that must precede any side effect |
| `POST` | `/api/browser-bridge/companions/sessions/:id/progress` | Reports completed action step, bound to the claimed attempt |
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
- Do not add dormant injected-script bundles to store artifacts. Wallet
  injection requires a separately reviewed explicit top-frame origin grant and
  a reachable, tested activation path.
- Sync runs on a 30-second alarm (`SYNC_INTERVAL_MINUTES = 0.5`) and is debounced 750ms after tab events. Do not remove the debounce — rapid tab events would otherwise flood the agent API.
- `isCompanionAuthError()` in the background detects expired/revoked pairing tokens and clears stored config so the popup can require a newly authenticated manual pairing.
- Unit tests in `src/storage.test.ts` use `jsdom` via `vitest.extension.config.ts`. Do not run `bun test` from the repo root for this package — it uses its own vitest config.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — CLI / tooling:**
- The real command/flow invocation transcript (args in, stdout/stderr, exit code) and the artifacts it generated (files, scaffolds, manifests, screenshots/recordings).
- Failure paths: bad args, missing deps, partial state, permission/network errors.
- A recording/log of the actual run end to end — not a unit test of one helper.
- Any model interaction captured as a live trajectory and reviewed.
<!-- END: evidence-and-e2e-mandate -->
