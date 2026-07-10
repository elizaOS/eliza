# e2e + Screenshot Test Harness Map (packages/app ui-smoke)

Scope: feeding a redesign where EVERY view must be screenshotted + e2e-tested.
Repo: `/home/shaw/eliza`. Working package: `packages/app`.

---

## 0. TL;DR — easiest path

The infrastructure for "screenshot every view at desktop + mobile" **already
exists and works**. There is no need to invent a harness:

- **Boot the stack once, reuse it:** start the live-stack server, then run any
  spec with `ELIZA_UI_SMOKE_REUSE_SERVER=1` so Playwright reuses the running
  port instead of cold-rebuilding (`reuseExistingServer` in
  `packages/app/playwright.ui-smoke.config.ts:80`).
- **Navigate to an arbitrary view:** `openAppPath(page, "/apps/plugins")` —
  the standard helper in `packages/app/test/ui-smoke/helpers.ts:367`. Routes are
  **real URL pathname routes** (`/chat`, `/settings`, `/apps/plugins`,
  `/companion/tui`), NOT hash routes and NOT `eliza:navigate:view` events. The
  full canonical path map is `TAB_PATHS` in
  `packages/ui/src/navigation/index.ts:285`.
- **Screenshot desktop + mobile:** call `page.setViewportSize(...)` then
  `captureScreenshotWithQualityRetry(page, label, { path })` from
  `packages/app/test/ui-smoke/helpers/screenshot-quality.ts:97`. The exact
  "iterate VIEW_CASES, screenshot each" pattern is already implemented in
  `packages/app/test/ui-smoke/plugin-views-visual.spec.ts`.
- **Auth/onboarding:** seeded via localStorage, no real login. `seedAppStorage`
  sets `eliza:first-run-complete=1` + a fake `elizaos:active-server`
  (`helpers.ts:183-217`). `installDefaultAppRoutes` mocks every `/api/*`
  (`helpers.ts:1719`) so specs run **keyless against an in-page stub** — the
  agent backend is never required for view rendering.
- **Chromium is installed:** `chromium-1228` at
  `/home/shaw/.cache/ms-playwright/chromium-1228/chrome-linux/chrome`.
  No `ELIZA_UI_SMOKE_CHROMIUM_EXECUTABLE` needed.

---

## 1. THE LIVE STACK HARNESS

File: `packages/app-core/scripts/playwright-ui-live-stack.ts`
Wired by: `packages/app/playwright.ui-smoke.config.ts` `webServer.command`.

### What it boots
Two pieces:

1. **API backend** — one of two modes (decided by
   `shouldForceStubStack(process.env)`, `lib/ui-smoke-stub-decision.mjs`):
   - **Stub stack** (`startStubStack`, line ~538): spawns
     `playwright-ui-smoke-api-stub.mjs` (a deterministic fake API). Used when
     `ELIZA_UI_SMOKE_FORCE_STUB=1` (always wins) or `CI=true` without
     `ELIZA_UI_SMOKE_LIVE_STACK=1`. **This is the default lane** — the runner
     `run-ui-playwright.mjs:35-36` sets `ELIZA_UI_SMOKE_FORCE_STUB=1` unless
     `ELIZA_UI_SMOKE_LIVE_STACK=1`.
   - **Real stack** (`startRealStack`, line ~593): spawns the actual app-core
     runtime (`packages/app-core/src/runtime/eliza.ts`) with a temp
     `ELIZA_STATE_DIR`, then POSTs `/api/first-run` (`submitFirstRun`,
     line ~480) using a real provider key from
     `OPENAI_API_KEY`/`GROQ_API_KEY`/`ANTHROPIC_API_KEY`/
     `GOOGLE_GENERATIVE_AI_API_KEY`/`OPENROUTER_API_KEY`/`ELIZAOS_CLOUD_API_KEY`.
     Falls back to stub if no key/`FORCE_STUB_STACK`.

2. **UI proxy server** (`startUiProxyServer`, line ~321): a plain `node:http`
   server on the UI port that:
   - serves the built renderer from `packages/app/dist/` (snapshotted per-run
     into the state dir via `snapshotUiDist`),
   - serves companion assets (`plugins/app-companion/public/` — animations,
     vrms, vrm-decoders),
   - proxies `/api/*` to the API backend,
   - relays `/ws` WebSocket to the API backend.
   It is NOT Vite — it serves a prebuilt static dist + reverse-proxies the API.

### Ports
- API: `ELIZA_UI_SMOKE_API_PORT` (default **31337**) — `live-stack.ts:38`.
- UI: `ELIZA_UI_SMOKE_PORT` (default **2138**) — `live-stack.ts:39`.
- The runner (`run-ui-playwright.mjs:40-50`) auto-shifts to free ports if the
  defaults are taken, and keeps `ELIZA_API_PORT` in sync.
- `playwright.ui-smoke.config.ts` reads the same two env vars; `baseURL` is
  `http://127.0.0.1:${uiSmokePort}`.

### Cold build cost
- `ensureUiDistReady` (line ~466) runs `bun run build:web` in `packages/app`
  only if `viteRendererBuildNeeded()` says the dist is stale (mtime heuristic).
- A **cold renderer build transforms ~3000 modules and measures ~12 min**;
  capped at 18 min (`RENDERER_BUILD_TIMEOUT_MS = 1_080_000`,
  `live-stack.ts`). The outer Playwright `webServer.timeout` is **20 min**
  (`1_200_000`, config line ~117) to clear that.
- Build env forces `ELIZA_DESKTOP_VITE_FAST_DIST=1` (skips the memory-heavy
  minify pass; smoke serves dist locally, never ships it).
- `ELIZA_UI_SMOKE_SKIP_BUILD=1` skips the rebuild when a built `index.html`
  already exists (escape hatch when only the stub/specs changed). The runner
  also pre-builds the view bundle unless `ELIZA_UI_SMOKE_SKIP_VIEW_BUILD=1`.

### Env knobs (all from live-stack.ts + config + runner)
| Var | Effect |
|---|---|
| `ELIZA_UI_SMOKE_REUSE_SERVER=1` | Playwright reuses an already-running stack instead of starting one (config `reuseExistingServer`, line 80). **Key for boot-once-reuse.** |
| `ELIZA_UI_SMOKE_PORT` | UI port (default 2138). |
| `ELIZA_UI_SMOKE_API_PORT` | API port (default 31337). |
| `ELIZA_UI_SMOKE_CHROMIUM_EXECUTABLE` | Override Chromium binary path (config lines ~88, ~111). Unset → Playwright's bundled chromium-1228. |
| `ELIZA_UI_SMOKE_DISABLE_VIDEO=1` | Sets video capture `off` (config line ~57); otherwise `retain-on-failure`, or `on` when `E2E_RECORD` is set. |
| `ELIZA_UI_SMOKE_FORCE_STUB=1` | Force the deterministic stub API (default in non-live lanes). |
| `ELIZA_UI_SMOKE_LIVE_STACK=1` | Opt into the real app-core runtime (needs a provider key). |
| `ELIZA_UI_SMOKE_SKIP_BUILD=1` | Skip renderer rebuild if a dist exists. |
| `ELIZA_VIEW_SCREENSHOT_DIR` | Override output dir for `plugin-views-visual.spec.ts` screenshots (default `test-results/plugin-views`). |
| `UPDATE_VISUAL_BASELINES=1` | Write/refresh PNG baselines in `lib/visual-snapshot.ts`. |

### How a spec navigates to a view
**Real pathname routes via `page.goto` + `openAppPath`.** There is NO hash
routing and NO `eliza:navigate:view` event used in tests. Mechanism
(`helpers.ts:367` `openAppPath`):
1. `page.goto(targetPath)` (e.g. `/apps/plugins`),
2. wait for `#root` visible + startup settled (`startup-shell-loading` gone,
   no first-run redirect),
3. `replayNavigationAfterStartup` (line 354) dispatches a `popstate` (or
   `hashchange` for `appWindow=1`/`file:` desktop) so the in-app router re-reads
   `window.location` after the shell finishes booting.
The in-app router (`packages/ui/src/App.tsx`, `getWindowNavigationPath()` line
~931) reads the pathname and resolves it through `TAB_PATHS`
(`packages/ui/src/navigation/index.ts:285`).

---

## 2. HOW SCREENSHOTS ARE CAPTURED

Two distinct mechanisms:

### (a) Playwright page screenshots — the live one used for views
- Helper: `captureScreenshotWithQualityRetry(page, label, opts)` in
  `packages/app/test/ui-smoke/helpers/screenshot-quality.ts:97`. Takes
  `page.screenshot({ path, fullPage, type })`, then runs a **blank-detection
  quality gate** (`analyzeScreenshot` via `sharp`: rejects empty / one-color /
  >99.5%-dominant frames) and retries up to N times.
- **Per-view visual audit spec already exists:**
  `packages/app/test/ui-smoke/plugin-views-visual.spec.ts`. It loops
  `VIEW_CASES` (from `plugin-view-cases.ts`), opens each via `openAppPath`,
  asserts the view mounted (`main` visible, real text, no "Failed to load
  view"), then writes `<screenshotDir>/<id>-<viewType>.png` +
  `<id>-<viewType>.audit.json`. **PNGs land in
  `packages/app/test-results/plugin-views/`** (or `ELIZA_VIEW_SCREENSHOT_DIR`).
- Other specs that screenshot pages the same way: `settings-audit-capture`,
  `assistant-home-flow`, `titlebar-navigation`, `view-manager-actual-flow`,
  `ai-qa-capture`, `tutorial-help-walkthrough` (grep `captureScreenshotWithQualityRetry|page.screenshot(`).
- Playwright config also auto-screenshots `only-on-failure` (config `use.screenshot`).

### (b) Baseline PNG diffing — Electrobun OS-level, NOT used for in-page views
- `packages/app/test/ui-smoke/lib/visual-snapshot.ts`:
  `captureDesktopScreenshot()` pulls `GET /api/dev/cursor-screenshot` (the
  native Electrobun window) and `assertMatchesBaseline()` diffs against
  `packages/app/test/ui-smoke/__visual__/<name>.png` using pixelmatch+pngjs
  (falls back to size+sha256). Refresh with `UPDATE_VISUAL_BASELINES=1`.
  This is for native-desktop chrome, not the React views — **for the redesign's
  per-view shots use mechanism (a).**
- There is NO `toHaveScreenshot()` usage anywhere in the suite (grep is empty);
  the project deliberately uses byte-quality gating + manual baselines instead
  of Playwright's built-in snapshot assertion.

### Pattern to add "screenshot every view at desktop + mobile"
The cleanest insertion point is to extend `plugin-views-visual.spec.ts` (or
clone it) to loop over BOTH the plugin `VIEW_CASES` AND the builtin
`TAB_PATHS`, and to wrap each in a viewport loop:

```ts
const VIEWPORTS = [
  { name: "desktop", size: { width: 1440, height: 1000 } },
  { name: "mobile",  size: { width: 390,  height: 844  } },
];
for (const vp of VIEWPORTS) for (const view of ALL_VIEWS) {
  test(`${view.id} ${vp.name}`, async ({ page }) => {
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    await page.setViewportSize(vp.size);
    await openAppPath(page, view.path);
    await expect(page.locator("main").first()).toBeVisible({ timeout: 60_000 });
    await captureScreenshotWithQualityRetry(page, `${view.id}-${vp.name}`, {
      path: `${dir}/${vp.name}/${view.id}.png`, attempts: 4,
    });
  });
}
```
The desktop `1440×1000` / mobile `390×844` viewport sizes are exactly what
`all-pages-clicksafe.spec.ts` already uses (`DESKTOP_PROBE` / `MOBILE_PROBE`,
lines ~1556/1574). The mobile lane in the Playwright config uses Pixel 7 device
emulation (config `mobile-chromium` project) but is restricted to a regex of
specs; for a screenshot sweep, manual `setViewportSize` is simpler and runs in
the default `chromium` project.

---

## 3. COVERAGE MAP

### Canonical builtin views (TAB_PATHS, `packages/ui/src/navigation/index.ts:285`)
Every builtin tab → path, with current e2e coverage:

| Tab id | Path | e2e coverage |
|---|---|---|
| chat | `/chat` | ✅ all-pages CORE_ROUTE_PROBES; many chat-*.spec.ts |
| (home) | `/` | ✅ all-pages "assistant home"; assistant-home-flow.spec |
| phone | `/phone` | ✅ all-pages (deep link); plugin-view-cases |
| messages | `/messages` | ✅ all-pages; plugin-view-cases |
| contacts | `/contacts` | ✅ all-pages; plugin-view-cases |
| camera | `/camera` | ✅ all-pages (deep link probe) |
| lifeops | `/apps/lifeops` | ✅ DIRECT_ROUTE_CASES; apps-personal-assistant-*; plugin-view-cases |
| tasks | `/apps/tasks` | ✅ apps-builtin-pages (automations); orchestrator/task-coordinator specs |
| automations | `/automations` | ✅ all-pages; automations.spec.ts |
| browser | `/browser` | ✅ all-pages; browser-workspace.spec.ts |
| companion | `/companion` | ✅ all-pages; plugin-view-cases; DIRECT_ROUTE_CASES |
| stream | `/stream` | ✅ all-pages; apps-builtin-pages "stream view" |
| apps | `/apps` | ✅ all-pages "apps catalog" |
| views | `/views` | ✅ all-pages "views catalog"; plugin-views-lifecycle |
| character | `/character` | ✅ all-pages |
| character-select | `/character/select` | ✅ all-pages |
| inventory | `/wallet` | ✅ all-pages "wallet"; wallet-keys; DIRECT_ROUTE_CASES |
| documents | `/character/documents` | ✅ all-pages (deep link) |
| triggers | `/automations` | ✅ (alias of automations) |
| plugins | `/apps/plugins` | ✅ apps-builtin-pages; DIRECT_ROUTE_CASES |
| skills | `/apps/skills` | ✅ apps-builtin-pages; DIRECT_ROUTE_CASES |
| advanced | `/apps/fine-tuning` | ✅ (alias of fine-tuning) |
| fine-tuning | `/apps/fine-tuning` | ✅ apps-model-training-interactions; DIRECT_ROUTE_CASES |
| trajectories | `/apps/trajectories` | ✅ apps-builtin-pages; DIRECT_ROUTE_CASES |
| relationships | `/apps/relationships` | ✅ apps-builtin-pages; DIRECT_ROUTE_CASES |
| memories | `/apps/memories` | ✅ DIRECT_ROUTE_CASES (memory-viewer-view) |
| rolodex | `/rolodex` | ✅ all-pages; apps-builtin-pages "rolodex" |
| voice | `/settings/voice` | ✅ all-pages "settings voice path" |
| runtime | `/apps/runtime` | ✅ apps-builtin-pages "runtime view" |
| database | `/apps/database` | ✅ apps-builtin-pages "database view" |
| logs | `/apps/logs` | ⚠️ route exists, only render-smoked via all-pages catalog; **no dedicated interaction spec** |
| desktop | `/desktop` | ✅ all-pages (deep link); desktop-workspace-interactions |
| settings | `/settings` | ✅ all-pages; settings-*.spec.ts (3 specs) |
| tutorial | `/tutorial` | ✅ all-pages; tutorial-help-views/walkthrough |
| help | `/help` | ✅ all-pages; tutorial-help-views/walkthrough |

**Builtin coverage is essentially complete.** The only thin spot is **`/apps/logs`
(Log Viewer)** — it has a route + internal-tool-app entry
(`internal-tool-apps.ts` displayName "Log Viewer", windowPath `/apps/logs`) but
no dedicated interaction spec; it's only reached as a catalog tile.

Builtin internal-tool-apps NOT in the core route probe list but with windowPaths
(reached only via the app catalog / DIRECT_ROUTE_CASES, worth explicit
screenshots): `/apps/inventory` (Steward), `/inventory` (wallet shell),
`/apps/runtime`, `/apps/logs`.

### Plugin views (`plugin-view-cases.ts` VIEW_CASES — 64 cases, gui+tui)
Covered by THREE specs that all iterate `VIEW_CASES`:
- `plugin-views-visual.spec.ts` — screenshot + a11y/control audit per case.
- `plugin-views-lifecycle.spec.ts` — mount → unmount → reopen → reload per case.
- (cases shared) `plugin-view-cases.ts`.

Plugin view ids covered (each gui + most also tui): companion, contacts,
hyperliquid, lifeops, focus, calendar, documents, finances, goals, health,
inbox, relationships, todos, messages, model-tester, phone, polymarket,
shopify, steward, wallet, vector-browser, feed,
views-manager,
screenshare, task-coordinator, orchestrator, trajectory-logger,
training, facewear, smartglasses.

### Per-spec coverage highlights (66 spec files)
- Route render-smoke (all viewports): `all-pages-clicksafe.spec.ts` (35 route
  probes × desktop + mobile = the broad render gate).
- App-window deep routes: `apps-session-route-cases.ts` →
  `apps-session-direct-*.spec.ts`.
- Domain interaction specs: `apps-builtin-pages-interactions`,
  `apps-model-training-interactions`, `apps-comms-device-interactions`,
  `apps-personal-assistant-*`, `apps-utility-interactions`,
  `apps-diagnostics-interactions`, `connectors`, `automations`,
  `conversation-management`, `settings-*` (×3), `vault-*` (×2),
  `orchestrator-gui-workbench`, `task-coordinator-gui`, `game-*`,
  `screenshare/screenshare-gui`, voice (`voice-*`, `tts-stt-e2e`).
- Startup/auth: `auth-startup`, `first-run-startup`, `cloud-provisioning-startup`,
  `warming-shell-startup`, `reset-returns-to-onboarding`.

### Gaps / no dedicated coverage
- `/apps/logs` (Log Viewer): catalog-only.
- No single "screenshot every builtin view at desktop+mobile" sweep — only
  plugin views get systematic screenshots (`plugin-views-visual`). Builtin
  pages are render-asserted (all-pages) but NOT systematically screenshotted at
  both viewports. **This is the main gap to close for the redesign.**

---

## 4. HOW TO RUN LOCALLY

All commands from repo root `/home/shaw/eliza`.

### Cold build + run the full suite (default stub lane)
```bash
bun run --cwd packages/app test:e2e
```
This invokes `node scripts/run-ui-playwright.mjs --config
playwright.ui-smoke.config.ts`, which sets `ELIZA_UI_SMOKE_FORCE_STUB=1`,
reserves free ports, builds the renderer if stale (~12 min cold), boots the
live-stack webServer, and runs every spec. workers:1, fullyParallel:false.

### Run ONE spec (still boots its own server)
```bash
bun run --cwd packages/app test:e2e test/ui-smoke/plugin-views-visual.spec.ts
```

### Boot the stack ONCE and reuse it across runs (fast iteration)
Terminal A — start the live stack standalone:
```bash
cd /home/shaw/eliza
ELIZA_UI_SMOKE_FORCE_STUB=1 ELIZA_UI_SMOKE_PORT=2138 ELIZA_UI_SMOKE_API_PORT=31337 \
  node packages/app-core/scripts/run-node-tsx.mjs \
  packages/app-core/scripts/playwright-ui-live-stack.ts
```
Terminal B — run specs against it (skip cold build, reuse the port):
```bash
cd /home/shaw/eliza/packages/app
ELIZA_UI_SMOKE_REUSE_SERVER=1 ELIZA_UI_SMOKE_PORT=2138 ELIZA_UI_SMOKE_API_PORT=31337 \
ELIZA_UI_SMOKE_SKIP_BUILD=1 \
  bunx playwright test --config playwright.ui-smoke.config.ts \
  test/ui-smoke/plugin-views-visual.spec.ts
```
`reuseExistingServer` (config line 80) makes Playwright detect the already-bound
port 2138 and skip starting a second server. Keep the env ports identical in
both terminals.

> Note: running `bunx playwright test` directly (instead of `test:e2e`) skips
> the runner's auto-port-shift and force-stub defaults, so set
> `ELIZA_UI_SMOKE_FORCE_STUB=1` + the ports explicitly, as above.

### Real-backend (live LLM through the UI) lane
```bash
ELIZA_UI_SMOKE_LIVE_STACK=1 OPENAI_API_KEY=sk-... \
  bun run --cwd packages/app test:e2e
```

### Disable video to speed up
Append `ELIZA_UI_SMOKE_DISABLE_VIDEO=1`.

---

## 5. CHROMIUM AVAILABILITY

✅ **Installed and ready.** `npx playwright install --dry-run` reports
`Chrome for Testing 149.0.7827.55 (playwright chromium v1228)` at
`/home/shaw/.cache/ms-playwright/chromium-1228`, and the binary exists at
`/home/shaw/.cache/ms-playwright/chromium-1228/chrome-linux/chrome` (confirmed).
A system `/usr/bin/google-chrome` is also present.

- No `ELIZA_UI_SMOKE_CHROMIUM_EXECUTABLE` needed — the config defaults to
  Playwright's bundled chromium when the env var is unset (config lines ~88,
  ~111). Only set it to pin a specific binary.
- The voice-mic lane (`chromium-voice-mic` project) adds fake-audio launch
  flags; irrelevant to view screenshots.

---

## 6. LOGIN / AUTH STATE FOR TESTS

No real login. Specs get past first-run/onboarding two ways, used together:

### (a) localStorage seeding — `seedAppStorage` (`helpers.ts:200`)
Uses `page.addInitScript` to set, before any app JS runs
(`DEFAULT_APP_STORAGE`, `helpers.ts:183`):
```
eliza:first-run-complete = "1"            // skips onboarding/first-run shell
eliza:setup:step         = "activate"
eliza:ui-shell-mode      = "native"
elizaos:active-server    = {"id":"local:embedded","kind":"local","label":"This device"}
```
Idempotent via a `sessionStorage` `eliza:ui-smoke-storage-seeded` flag. Pass
`overrides` to seed extra keys (e.g. force cloud/local server).

### (b) API stubbing — `installDefaultAppRoutes` (`helpers.ts:1719`)
`page.route` mocks for every backend dependency the shell hits on boot, so the
UI thinks it's connected to a running, authed local agent **without a real
backend**:
- `/api/status` → `{ state: "running", agentName: "Playwright Smoke", ... }`
- `/api/health` → `{ ok: true }`
- `/api/first-run/status` → `{ ..., meta: { firstRunComplete: true } }`
  (helpers.ts:1850)
- `/api/auth/me` → local session (`session.kind: "local"`),
  `/api/auth/sessions` → `[]`
- plus runtime/mode, views, plugins, wallet, vrm assets, brand assets, etc.

The live-stack stub API (`playwright-ui-smoke-api-stub.mjs`) independently
serves the same `firstRunComplete:true` + `session.kind:"local"` state so even
without `installDefaultAppRoutes` the served stack is past onboarding
(`startStubStack` waits on `/api/first-run/status`, `/api/status` state
`running`, `/api/auth/me` session `local`).

### Real-stack path
When `ELIZA_UI_SMOKE_LIVE_STACK=1` + a provider key, `submitFirstRun`
(`live-stack.ts:480`) POSTs `/api/first-run` with the real provider/model and
polls `/api/first-run/status` until `complete:true` — i.e. it actually completes
onboarding server-side once before the specs run.

**For the redesign screenshot sweep:** call `seedAppStorage(page)` +
`installDefaultAppRoutes(page)` in `beforeEach` (exactly as
`plugin-views-visual.spec.ts` does) and you land directly on any view with no
auth flow. Add per-view route stubs only for views that hit a unique endpoint.

---

## Key file index
- `packages/app-core/scripts/playwright-ui-live-stack.ts` — the stack harness.
- `packages/app-core/scripts/lib/ui-smoke-stub-decision.mjs` — stub vs live decision.
- `packages/app/playwright.ui-smoke.config.ts` — Playwright config (ports, viewports, webServer, reuse).
- `packages/app/scripts/run-ui-playwright.mjs` — `test:e2e` runner (port shift, force-stub default).
- `packages/app/test/ui-smoke/helpers.ts` — `openAppPath` (367), `seedAppStorage` (200), `installDefaultAppRoutes` (1719).
- `packages/app/test/ui-smoke/helpers/screenshot-quality.ts` — `captureScreenshotWithQualityRetry` (97).
- `packages/app/test/ui-smoke/lib/visual-snapshot.ts` — Electrobun baseline diffing (not for in-page views).
- `packages/app/test/ui-smoke/plugin-views-visual.spec.ts` — **the per-view screenshot pattern to copy**.
- `packages/app/test/ui-smoke/plugin-view-cases.ts` — `VIEW_CASES` (64 plugin views).
- `packages/app/test/ui-smoke/plugin-views-lifecycle.spec.ts` — mount/unmount/reload per view.
- `packages/app/test/ui-smoke/all-pages-clicksafe.spec.ts` — 35 routes × desktop+mobile render-smoke; `DESKTOP_PROBE`/`MOBILE_PROBE` viewport sizes.
- `packages/app/test/ui-smoke/apps-session-route-cases.ts` — DIRECT_ROUTE_CASES (app-window deep routes).
- `packages/app/test/ui-smoke/apps-builtin-pages-interactions.spec.ts` — runtime/plugins/database/skills/trajectories/relationships/stream/rolodex interaction specs.
- `packages/ui/src/navigation/index.ts:285` — `TAB_PATHS` canonical builtin tab→path registry.
- `packages/ui/src/components/apps/internal-tool-apps.ts` — internal-tool-app windowPaths.
