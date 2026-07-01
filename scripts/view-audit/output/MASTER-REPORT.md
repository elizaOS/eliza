# elizaOS View Audit — Master Issue Report

## 1. Executive Summary

**32 views audited** across the real Pixel 9a device + web dev agent.

### Counts by classification

| Classification | Count | Views |
|---|---|---|
| **REAL_BUG** | 7 | fine-tuning, knowledge, tasks, wallet, browser, hyperliquid, wallet.inventory |
| **MIXED** | 6 | logs, automations, trajectory-logger, phone-companion, plugins |
| **EXPECTED** | 13 | trajectories, relationships, memories, stream, smartglasses, polymarket, settings.wallet-rpc, apps-catalog, database, phone, messages, contacts |
| **DEV_ARTIFACT** | 5 | views-catalog, character, rolodex, orchestrator, facewear |

### Counts by severity

| Severity | Count | Views |
|---|---|---|
| **P1** | 4 | fine-tuning, knowledge, browser, plugins |
| **P2** | 7 | tasks, wallet, wallet.inventory, automations, phone-companion, hyperliquid |
| **P3** | 3 | logs, polymarket, database |
| **none** | 18 | (all EXPECTED + DEV_ARTIFACT) |

### Headline real bugs (the must-fixes)

1. **fine-tuning (P1)** — 14 training endpoints implemented but never registered in `TRAINING_ROUTES`; the view shows a "Not found" banner on **every** surface including the full device.
2. **knowledge (P1)** — `/api/documents` is never mounted on the Android agent (app-core boot tail doesn't run on mobile); the Knowledge view shows "Not found / Retry" forever on device. **Inverse of the usual pattern: web works, device fails.**
3. **browser (P1)** — the inline `server.ts` browser-workspace handler calls `getBrowserWorkspaceSnapshot()` on the mobile null-stub → `"is not a function"` raw JS error rendered on device; browser feature is non-functional on real hardware.
4. **plugins (P1)** — Plugin Catalog renders **empty** on device (`/api/plugins` returned 200 with `[]` at capture); compounded by a silent `catch {}` and no loading/error state so empty/failed/loading all look identical.

---

## 2. P0 / P1 Real Bugs (must-fix)

| View | Route | Issue | Root cause | File | Fix |
|---|---|---|---|---|---|
| **fine-tuning** (P1) | `GET /api/training/collections` (+13 siblings) | Red "Not found" banner on **all** surfaces (device included); `refreshAll` Promise.all rejects on the collections 404 | 14 endpoints are implemented in `handleTrainingRoutes` but absent from the exact-match `TRAINING_ROUTES` list, so the router never reaches them → bare 404 | `plugins/plugin-training/src/setup-routes.ts:222` (registration list); handler `plugins/plugin-training/src/routes/training-routes.ts:584`; view `FineTuningView.tsx:1049,1059` | Add the 14 missing `{type,path}` entries to `TRAINING_ROUTES`. Secondary: give `loadCollectionHistory` its own try/catch so one failure doesn't blank the whole refresh |
| **knowledge** (P1) | `GET /api/documents` | Device-only "Not found / Retry" loop; web works | Documents routes load **only** via app-core's `registerAppRoutePlugins` post-ready boot tail, which the mobile agent (boots through `@elizaos/agent` to avoid the agent→app-core cycle) never runs; plugin also absent from `MOBILE_VIEW_PLUGINS` allow-list | `DocumentsView.tsx:494-508,1348-1364`; gap at `agent/src/runtime/plugin-collector.ts:710-725` + `app-core/src/runtime/eliza.ts:450-465` | Add `@elizaos/plugin-documents` as a `workspace:*` dep of `@elizaos/agent`, add it to `MOBILE_VIEW_PLUGINS` (`core-plugins.ts:54-67`), and add a static-import case in `loadOptionalPlugin` (`eliza.ts:320-349`). Fallback: Android empty-list stubs mirroring iOS `ios-local-agent-kernel.ts:3073-3107` |
| **browser** (P1) | `GET /api/browser-workspace`, `/api/browser-bridge/packages` | Device shows raw `"browserPlugin.getBrowserWorkspaceSnapshot is not a function"`; workspace never loads, bridge-setup UI absent | `server.ts` unconditionally registers an inline duplicate of the browser routes that calls into `@elizaos/plugin-browser`, which is the mobile null-stub; the missing method isn't in `PRE_POPULATED_NAMES` → undefined → throw; no try/catch → 500 | `server.ts:1076-1080` (inline handler), `:74` (getBrowserPlugin); view `BrowserWorkspaceView.tsx:859,2609`; stub `build-mobile-bundle.mjs:399` | Short-circuit the inline handlers when `isMobilePlatform()` and return an empty `BrowserWorkspaceSnapshot`; best long-term: delete the inline `server.ts` duplicates and let only the plugin-owned routes serve them (route simply 404s when plugin absent → clean catch) |
| **plugins** (P1) | `GET /api/plugins` | Device catalog renders **empty** ("No plugins available") though static registry should yield ~155 (web shows them) | Endpoint returned 200 with empty list at capture (likely registry/manifest projection unresolved in the packaged Android bundle, or a deferred-app-routes readiness race), made invisible by a bare `catch {}` and a view with no loading state | view `PluginsView.tsx:1322,259-263`; swallow `usePluginsSkillsState.ts:175-183`; builder `app-plugins-routes.ts:1081` | (1) Stop swallowing: log + set `pluginsLoadError`, add `pluginsLoaded`/`isLoadingPlugins`; render a skeleton while loading and a retry panel on error, reserving "No plugins available" for confirmed-empty. (2) Root-cause the device empty list: verify `loadRegistry()`/`resolvePluginManifestPath()` resolve in the packaged APK, and re-fetch on the agent-ready event if it's a readiness race |

---

## 3. P2 / P3 Real Bugs & Poor UX

| View | Sev | Route | Issue | Root cause | File | Fix |
|---|---|---|---|---|---|---|
| **tasks** | P2 | `GET /api/orchestrator/tasks` | Scary red "Failed to load task threads: Not found" banner on **every** surface | Panel depends on orchestrator route owned only by Node-only `plugin-agent-orchestrator` (can't run on mobile/browser); 404 is rendered as a hard load failure | `CodingAgentTasksPanel.tsx:648,667,895`; endpoint `plugin-agent-orchestrator/src/api/orchestrator-routes.ts:235` | In the `refreshThreads` catch: `if (error instanceof ApiError && error.status === 404) { setThreads([]); setLoadError(null); return; }` — show the existing "No coding tasks yet" empty state. Reserve the banner for 5xx/transport |
| **wallet** | P2 | `GET /api/wallet/nfts` | Red "Failed to fetch NFTs: Not found" banner pinned over an otherwise-correct wallet on device | `/api/wallet/nfts` was unhandled by the always-loaded `plugin-wallet`, so `handleWalletRoutes` returned false and the server emitted 404 | `InventoryView.tsx:2184`; `useWalletState.ts:318`; gap `plugin-wallet/src/api/wallet-routes.ts:1715` | Done: `plugin-wallet` handles `GET /api/wallet/nfts` with 200 `{evm:[],solana:null}` fallback when no source is configured; keep the defensive 404-as-empty guard in `loadNfts` |
| **wallet.inventory** | P2 | `GET /api/wallet/nfts` | Same NFT 404 banner on a configured wallet | Same as `wallet` — auto-enabled `plugin-wallet` had no `/nfts` branch | `InventoryView.tsx:2184`; `useWalletState.ts:311-323`; `client-wallet.ts:209-211` | Done: `plugin-wallet` owns `GET /api/wallet/nfts` and returns 200 with empty arrays when no keys/RPC/source are available |
| **automations** | P2 | `GET /api/automations` | Raw red "Not found" banner between filter chips and empty state on device | Endpoint owned only by `plugin-workflow`, deliberately excluded from mobile ("Phones cannot host the workflow runtime"), but the tile is registered under mobile-loaded `plugin-task-coordinator` | `AutomationsFeed.tsx:235,238-245`; owner `plugin-workflow/src/routes/automations.ts:30`; exclusion `core-plugins.ts:39` | In the `refresh()` catch, `if (isApiError(e) && e.status === 404)` set an empty `AutomationListResponse` (clean "Nothing scheduled yet"), mirroring `StreamView.tsx:58`. Reserve banner for non-404 |
| **phone-companion** | P2 | n/a (Capacitor) | Uncaught `CapacitorException: "ElizaIntent" plugin is not implemented on android` | `ElizaIntent` registered with only a `web` fallback; no Android native plugin; `getPairingStatus()` called without `.catch()` | `PhoneCompanionApp.tsx:56`; registration `eliza-intent.ts:113` | (2, preferred) add `android: () => new ElizaIntentWeb()` to `registerPlugin` so Android resolves the web fallback (`paired:false`); (1) keep a `.catch()` guard on the call |
| **hyperliquid** | P2 | `GET /api/hyperliquid/status` | Self-contradictory "Not found · Reads blocked · 0 markets" on device (sibling Shopify/Polymarket degrade cleanly) | App-route plugin's bare `/plugin` subpath import is unresolvable in the mobile bundle → swallowed as `OptionalAppRoutePluginUnavailableError` → routes never mount → 404; hook surfaces raw error instead of degrading | `useHyperliquidState.ts:33-63`; copy `HyperliquidAppView.tsx:107-111` | Catch the `ApiError` 404 and set a degraded `{publicReadReady:false}` state with friendly copy ("Unavailable on this device"), mirroring `ShopifyAppView.helpers.ts:14-15`. Fix the "Reads blocked · 0 markets" copy |
| **logs** | P3 | `GET /api/logs` (works) | React duplicate-key warnings (4×) on the log rows | Log-row key `${timestamp}-${source}-${level}-${message}` collides for identical lines emitted in the same millisecond; `LogEntry` has no unique id | `LogsView.tsx:308-310` | Add the array index to the key: `filteredLogs.map((entry, i) => ...)` with `key={`${i}-${entry.timestamp}-${entry.source}-${entry.level}`}` |
| **polymarket** | P3 | `GET /api/polymarket/markets` (→ upstream) | Device "Markets unavailable" because the agent couldn't reach `gamma-api.polymarket.com` (works on web) | External third-party API unreachable from the device process; view degrades gracefully (DisconnectedState) but has no manual retry | `PolymarketAppView.tsx:314` | Working-as-intended degradation; optional: add a "Retry" button calling the existing `refresh()` instead of waiting for the silent 20s poll |
| **database** | P3 | `GET /api/database/status` | Graceful "Database not available" empty state; transient web 404 (boot race) | Endpoint returns 200 `connected:false` when no adapter; device just had no adapter at probe; web 404 was a pre-runtime boot-timing race | `DatabaseView.tsx:525,537-543,130-149` | Working-as-intended; optional: pass `statusLoadError`/"agent may still be starting" hint into the external-sidebar `FeatureEmpty` (it already auto-revalidates every 30s + on focus) |

---

## 4. Dev-Config Artifacts (web-dev-only 404s — work on the real device; **not bugs**)

These 404s appear **only on the web `bun run dev` agent** because it doesn't load certain plugins. All consumers degrade gracefully; the real Pixel 9a device shows zero failures.

- **views-catalog** — `/api/coding-agents`, `/api/orchestrator/status`, `/api/orchestrator/tasks`. Status poller uses `Promise.allSettled→null`.
- **character** — `/api/orchestrator/*` + `/api/coding-agents` 404/503 + WS refused, all from the global task-coordinator widget, not the view's own (successful) fetches.
- **orchestrator** — `/api/orchestrator/status`, `/api/orchestrator/tasks`. The view explicitly routes the 404 through `isOrchestratorBackendAbsent` → calm "Connect a cloud or desktop agent" hint (documented intended behavior).
- **facewear** — `/api/facewear/status` (plugin not loaded on web; `if (res.ok)` guard absorbs it → default empty state).

> Owner of most of these: `plugin-agent-orchestrator` / `plugin-task-coordinator` are intentionally not loaded on the web dev agent. Optional dev nicety: register or stub these in the web harness to silence console noise.

---

## 5. Expected / Working-As-Intended (graceful no-agent / offline / no-data states)

Many views were flagged only by the crawler's **`notFound`/`offline` body-text substring heuristic** (`/\b404\b|not found|couldn'?t reach|unavailable|markets unavailable|reads blocked/i`, `cdp-crawler.mjs:204`), which matches in-content empty-state copy or the surrounding shell chrome — **not real failures** (zero exceptions/netFailures/errorBoundary).

- **trajectories** — genuine "No trajectories yet" empty state; flag matched chat-surface "Not found" text.
- **relationships** — full graph + owner node; flag matched "No facts."/"No relationships." sub-panel copy.
- **memories** — full feed; `errorBoundary` flag matched a stored chat memory literally containing "Something went wrong on my…".
- **stream** — correct "STREAMING UNAVAILABLE / enable the streaming plugin" degradation (404→`setStreamAvailable(false)` by design); blank web capture is a pre-hydration timing artifact.
- **smartglasses** — correct "Offline / Web Bluetooth unavailable" when no G1 paired; flag matched "unavailable".
- **settings.wallet-rpc** — renders fully (core `/api/secrets/inventory` route); device flag matched shell-chrome body text. Empty wallet-keys list is the seeded-agent empty state.
- **apps-catalog** — full render on device; blank web body is a pre-hydration timing artifact; hero 404 is cosmetic (icon fallback).
- **phone / messages / contacts** — Android-fork-only surfaces; web correctly degrades to the Views catalog via `isAndroidPhoneSurfaceEnabled()` / `androidOnly` gating. Native permission prompts (READ_SMS/READ_CONTACTS) are graceful inline notices.

> **Crawler hygiene (optional, not a product fix):** scope the `notFound`/`errorBoundary` heuristics to the active view's content node (exclude shell chrome + floating chat), drop the bare token `"unavailable"`, and require a corroborating signal (actual 4xx in `netFailures` or a real error-boundary) before flagging. This would eliminate ~13 false positives.

---

## 6. Recurring Root Causes (cross-cutting patterns)

### A. The dominant pattern: a 404 from a not-loaded-on-this-surface route, rendered as a hard error banner
**7 of the 13 REAL_BUG/MIXED views** share one shape: a view calls an endpoint owned by a plugin that isn't loaded on the current surface, the client throws `ApiError("Not found")`, and the view sets it as a **danger banner** instead of degrading to an empty/unavailable state.

| View | Missing route | Owner plugin not loaded on |
|---|---|---|
| tasks | `/api/orchestrator/tasks` | mobile + web (Node-only orchestrator) |
| automations | `/api/automations` | mobile (workflow excluded) |
| hyperliquid | `/api/hyperliquid/status` | mobile (app-route subpath unresolvable) |
| wallet / wallet.inventory | `/api/wallet/nfts` | fixed in always-loaded `plugin-wallet` |
| knowledge | `/api/documents` | mobile (app-core boot tail skipped) |

**The fix is the same everywhere and already has precedent in-repo:** `StreamView.tsx:58` and `ShopifyAppView.helpers.ts:14-15` both special-case `status===404` and degrade to an unavailable/empty state. **These views should adopt that pattern.** A shared helper (e.g. `is404(err)` → degrade) would unify them. The banner must be reserved for genuine 5xx/transport failures.

### B. Endpoints registered in the wrong place / not at all
- **fine-tuning**: 14 handlers implemented but never added to the exact-match `TRAINING_ROUTES` list — a registration-list/handler drift that 404s on **every** surface (not surface-specific). High-confidence, isolated fix.
- **wallet NFTs**: fixed by moving `/api/wallet/nfts` into the always-loaded `plugin-wallet` route owner with an empty-list fallback when no NFT source is configured.

### C. Mobile-agent route gap (the inverse of the usual "web-only" artifacts)
`knowledge`, `browser`, `hyperliquid` (and the systemic device-wide app-route 404s) all stem from **the mobile/Android agent booting through `@elizaos/agent` and skipping `@elizaos/app-core`'s `registerAppRoutePlugins` boot tail**, plus the `MOBILE_*_PLUGINS` allow-lists. App-route/registry plugins that work on web/desktop simply don't mount on device. `browser` is the worst variant: the inline `server.ts` duplicate actively **calls into the null-stub** and throws a raw JS error instead of cleanly 404ing. Systemic options: bake the needed app-route plugins into the mobile bundle, or guard every inline `server.ts` optional-route handler against stub/absent plugins.

### D. Silent error swallowing hides real failures
- **plugins**: `catch {}` (`usePluginsSkillsState.ts:180`) + no loading state makes a genuinely-broken empty device catalog indistinguishable from "no plugins." This is the one place a 404-degrade would be **wrong** — it needs the **opposite**: stop swallowing, add `pluginsLoadError` + a loading/skeleton/retry distinction.

### E. Capacitor plugin registered for the wrong platform set
- **phone-companion**: `registerPlugin("ElizaIntent", { web: ... })` with no `android` entry throws an uncaught `CapacitorException` on Android. The web fallback already models the correct unsupported state — it just needs to be registered for `android` too. (Cross-reference the documented Capacitor thenable-proxy hazard: any `registerPlugin` without a native impl on a platform throws on call.)

### F. React key collision on append-only lists
- **logs**: keys derived purely from content collide for identical millisecond-coincident rows. Index-prefixed keys fix it; applies to any append-only log/feed render.
