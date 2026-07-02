# L1 — Launcher content policy: findings inventory + implemented fixes

Leg L1 of the UI-interaction epic (branch `feat/ui-interaction-launcher-epic`).
Research-first inventory of everything that renders on the launcher, how dev
mode leaks into it, the duplicates, and the fixes implemented.

## 1. Complete inventory — what renders on the launcher today

The launcher tile set is the union of three sources, merged in
`packages/ui/src/hooks/useAvailableViews.ts` (`useRoutableViews` →
`withBuiltinShellViews`) and curated by
`packages/ui/src/components/pages/launcher-curation.ts`
(`curateLauncherPages`, consumed by `LauncherSurface.tsx`):

### Source A — server view registry (`/api/views`)

Declared in `packages/agent/src/api/builtin-views.ts` (each with explicit
`viewKind`) plus plugin-registered views:

| id | label | viewKind | Launcher outcome |
|---|---|---|---|
| tutorial | Tutorial | system | apps page (uncurated, after curated order) |
| help | Help | system | apps page |
| camera | Camera | preview | AOSP-only (`LAUNCHER_AOSP_ONLY_IDS`) |
| chat | Chat | system | apps page slot 1 |
| character | Character | system | apps page |
| documents | Knowledge | system | apps page |
| automations | Automations | system | apps page |
| plugins-page | Plugins | system | alias → `plugins` (developer page) |
| trajectories | Trajectories | developer | developer page |
| transcripts | Transcripts | system | apps page |
| memories | Memories | system | apps page |
| database | Database | developer | developer page |
| logs | Logs | developer | developer page |
| settings | Settings | system | apps page slot 2 |
| background | Background | preview | hidden (`LAUNCHER_HIDDEN_IDS`) |

### Source B — builtin shell tabs (`TAB_PATHS`, `packages/ui/src/navigation/index.ts:280`)

Every entry becomes a `builtin: true` view entry (**no `viewKind` → resolves
"release" → always visible**) via `BUILTIN_SHELL_VIEW_ENTRIES`
(`useAvailableViews.ts:264`). Ids: chat, phone, messages, contacts, camera,
tasks, browser, stream, apps, views, character, character-select, automations,
triggers, inventory, documents, files, plugins, skills, advanced, fine-tuning,
trajectories, transcripts, relationships, memories, **rolodex**, runtime,
database, desktop, settings, tutorial, help, logs, background.

Curation outcome: `views`/`views-manager`/`apps`/`background`/`voice`/
`character-select`/`desktop` + removed apps + wallet sub-views are hidden
(`LAUNCHER_HIDDEN_IDS`, launcher-curation.ts:68); `inventory`→wallet,
`triggers|tasks|todos|task-coordinator`→automations, `advanced|training`→
fine-tuning, `plugins-page`→plugins, `trajectory-logger`→trajectories,
`log-viewer`→logs, `database-viewer`→database collapse via `CANONICAL_ID`
(launcher-curation.ts:93). Phone/messages/contacts/camera/files are AOSP-gated.

### Source C — in-process `registerAppShellPage` registrations

(`packages/ui/src/app-shell-registry.ts`; merged at `useAvailableViews.ts:290`)

| id | registration site | kind | Launcher outcome |
|---|---|---|---|
| hyperliquid | `plugins/plugin-hyperliquid/src/register.ts:19` | (release) | hidden — wallet sub-view |
| polymarket | `plugins/plugin-polymarket/src/register.ts:19` | (release) | hidden — wallet sub-view |
| feed | `plugins/plugin-feed/src/register.ts:12` | (release) | apps page (curated) |
| shopify | `plugins/plugin-shopify/src/register.ts:19` | (release) | hidden — removed app |
| wallet.inventory | `plugins/plugin-wallet-ui/src/register-routes.ts:25` | system | alias → wallet |
| trajectory-logger | `plugins/plugin-trajectory-logger/src/register.ts:26` | developer | alias → trajectories |
| phone-companion | `plugins/plugin-phone/src/register-companion-page.ts:15` | (release) | **apps-page tile on every platform** (see §4) |
| cloud-apps | `packages/app/src/cloud-apps-view.ts:29` | release | cloud-gated (`LAUNCHER_CLOUD_IDS`, #10725) |

## 2. How dev mode leaked into the default launcher under `bun run dev`

Two leaks, one seam:

1. **`defaultDeveloperMode()` returned `import.meta.env.DEV`**
   (`packages/ui/src/state/useDeveloperMode.ts:19-25`). Under `bun run dev`
   (any Vite dev build) Developer Mode defaulted ON, so every
   `developer`-kind view (launcher tiles, view manager, CommandPalette
   entries, route gates in `App.tsx:1332`, Settings sections) rendered by
   default. Developers did NOT see what users see. **FIXED** — default is now
   `false` on every build; the only way to see developer views is the
   persisted Settings toggle.

2. **Curated developer tiles bypassed the toggle entirely**
   (`launcher-curation.ts:207-213`, `const curated = … // Curated tiles
   always show`). The whole "Developer" page 2 — trajectories, database,
   runtime, logs, skills, plugins — rendered on EVERY build regardless of
   the Developer-views toggle; only *uncurated* developer views respected it.
   The file's own header ("plus any other developer-only view when Developer
   Mode is on") documented toggle-gating that the code didn't implement.
   **FIXED** — every developer-page entry (curated or not) now requires
   `enabledKinds.developer`; with the toggle off the launcher renders the
   apps page only.

Verified NON-leaks (checked, left alone — not tile visibility):
`platform/init.ts:58` (`canRunLocal` — runtime capability),
`DynamicViewLoader.tsx:1320` (dev bundle hot-reload),
`hooks/useRenderGuard.ts` (diagnostics), `cloud/admin/data/use-admin-gate.ts`
(cloud admin pages, documented dev rule), `renderer-build-stamp.ts`,
`genui devMode` (per-render prop, not env).

### The seam (existing, now made policy-true)

`viewKind` taxonomy in `packages/core/src/types/view-kind.ts`
(`isViewVisible`) → client toggle state `useEnabledViewKinds()`
(`packages/ui/src/state/useViewKinds.ts`) → persisted stores
`useDeveloperMode.ts` / `usePreviewMode.ts` (localStorage
`eliza:developerMode` / `eliza:previewMode`) → the user-facing switches
**Settings → Advanced → "View visibility" → "Developer views" / "Preview
views"** (`packages/ui/src/components/settings/AdvancedSection.tsx:275-295`).
No new mechanism was invented; the fixes route the two bypasses through this
existing seam.

## 3. Views/launcher button (epic item 3)

The right-side shell button that navigates to the launcher is the rail's
right edge chevron — `rail-pager-edge-next`, aria-label "Launcher"
(`HomeLauncherSurface.tsx:138-148` → `PagerEdgeButtons.tsx`, which returns
`null` per side, i.e. HIDES, when `canNext` is false). Verdict per required
case:

- **on launcher → hidden**: already correct (`canNext = page < pageCount-1`);
  asserted by `HomeLauncherSurface.test.tsx` ("moves one rail page per click").
- **navigate away → visible again**: was untested — assertion ADDED.
- **deep-link into launcher (`/views` → `initialPage="launcher"`) → hidden**:
  was untested — test ADDED.

The only other launcher-navigating controls: `chat-full-launcher`
(`ContinuousChatOverlay.tsx:3992` — L2-owned, see §5) and the Electrobun-only
`DesktopTabBar` "Open Launcher" (+) button (opens a separate launcher window;
tab bar never renders on the launcher window itself — N/A).

## 4. Duplicates / consolidation verdicts

| Item | Verdict | Action |
|---|---|---|
| `rolodex` builtin tab | **Dead duplicate of `relationships`** — `/rolodex` has no entry in App.tsx `directViews` (App.tsx:1096-1231) so its tile rendered `ViewUnavailableFallback`; a broken top-level tile named "Rolodex" next to a working "Relationships" tile | **implemented**: `CANONICAL_ID` alias `rolodex → relationships` (tile collapses onto the working view) |
| wallet/inventory, automations/triggers/tasks/todos, fine-tuning triple, plugins-page, trajectory-viewer/logger, log/db viewer | already collapsed by `CANONICAL_ID` (#10710) | none needed |
| `background`, `voice` as top-level tiles | already treated as settings-panel surfaces — in `LAUNCHER_HIDDEN_IDS` ("set from Settings/chat") | none needed |
| `phone-companion` tile on non-AOSP platforms | pairing/companion surface registered unconditionally; arguably belongs behind pairing state or AOSP gate | **recommend only** — product call (it is the *companion* for a phone elsewhere, so hiding it off-fork may be wrong) |
| `chat-full-launcher` button labeled "launcher" but calling `navigateHome` | label/behavior mismatch in full-chat header | **recommend only** — `ContinuousChatOverlay.tsx` is owned by leg L2 |
| `runtime`, `skills`, `plugins` on Developer page while server marks plugins `system` | curation deliberately classes them developer tooling; now consistently gated by the toggle | kept as curated (documented product call from #10710) |
| `fine-tuning` on apps page | real user-facing training surface, release kind | kept |

## 5. Implemented changes (this leg)

1. `packages/ui/src/state/useDeveloperMode.ts` — Developer Mode defaults OFF
   in ALL builds including dev; removed the `import.meta.env.DEV` bypass.
   Explicit user choice (localStorage) is the only way it turns on.
2. `packages/ui/src/state/useDeveloperMode.test.ts` — NEW: default-off under
   a dev build (vitest runs with `import.meta.env.DEV === true`, so the test
   is a real dev-build probe), persisted choice wins both ways, setter
   round-trip + subscriber notification, cross-tab storage sync.
3. `packages/ui/src/components/pages/launcher-curation.ts` — developer-page
   entries (curated AND uncurated) hidden unless `enabledKinds.developer`;
   `rolodex → relationships` alias; header/comment docs updated to match the
   actual policy.
4. `packages/ui/src/components/pages/launcher-curation.test.ts` — NEW cases:
   default toggles (developer:false) hide the entire Developer page including
   curated tiles; toggle-on restores the exact two-page layout; rolodex
   collapse. Existing full-realistic-set expectations updated to pass
   explicit toggle state.
5. `packages/core/src/types/view-kind.ts` — doc text updated ("developer:
   off by default on every build until enabled in Settings") so the taxonomy
   doc no longer promises a dev-build default the client must not implement.
6. `packages/ui/src/components/settings/AdvancedSection.tsx` — toggle
   description updated ("Off by default; applies to every build including
   dev.").
7. `packages/ui/src/components/shell/HomeLauncherSurface.test.tsx` — launcher
   button visibility coverage: deep-link (`initialPage="launcher"`) hides
   `rail-pager-edge-next`; navigating back home makes it visible again.

## 6. Recommendations NOT implemented (need a product call)

- `phone-companion` unconditional apps-page tile (gate behind pairing state?).
- `chat-full-launcher` header button: hide when the launcher surface is
  already the active underlay + fix label/handler mismatch — L2-owned file.
- `tutorial`/`help` as two separate top-level tiles (could fold Help into
  Tutorial or Settings).
- Server `builtin-views.ts` marks `plugins-page` `system` while curation
  treats plugins as developer tooling — server/client kind disagreement worth
  unifying upstream.
- `BUILTIN_SHELL_VIEW_ENTRIES` ships every `TAB_PATHS` id with no `viewKind`
  (all default release). A per-tab kind map would let the registry, not the
  curation blocklist, own classification.

## 7. Screenshot evidence

- `launcher-dev-default-BEFORE.png` / `-BEFORE-devpage.png` — the OLD
  dev-build default (developer views on): 2 pages; page 2 is the dev clutter
  (Trajectories/Database/Runtime/Logs/Skills/Plugins/Vector Browser, DEV
  badges visible).
- `launcher-dev-default-AFTER.png` — out-of-the-box defaults after the fix,
  same dev-build condition: ONE page, system/release apps only — exactly what
  a user sees.
- `launcher-dev-toggle-on-AFTER.png` / `-AFTER-devpage.png` — after flipping
  Settings → Advanced → "Developer views": the Developer page is restored.

Captured by `run-l1-policy-capture.mjs` + `l1-policy-fixture.tsx` (in this
directory): esbuild-bundles the REAL `Launcher` + REAL `curateLauncherPages`
over the realistic view set and drives them in headless Chromium (Playwright),
asserting page counts / tile presence / rolodex collapse before each capture
(run: `cd packages/ui && bun <evidence-dir>/run-l1-policy-capture.mjs` — all
assertions passed, 0 page errors). All five PNGs reviewed by eye.
