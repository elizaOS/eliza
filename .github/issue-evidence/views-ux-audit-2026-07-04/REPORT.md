# Views UX Audit - 2026-07-04

## Scope

Captured route-level screenshots for built-in launcher, settings, wallet, browser, and related app views with:

```bash
ELIZA_NODE_PATH=/Users/shawwalters/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
ELIZA_AUDIT_APP_DIR=.github/issue-evidence/views-ux-audit-2026-07-04/aesthetic-audit-output \
bun run --cwd packages/app audit:app
```

The first `audit:app` run completed 122 of 349 audit checks before it was terminated by SIGTERM. It captured 121 screenshots and 121 manual-review stubs, covering all built-in views through `builtin-logs mobile-portrait`. Plugin views were not reached in that run.

A focused settings-subview pass then succeeded against a reusable Vite server:

```bash
ELIZA_SETTINGS_AUDIT=1 \
ELIZA_UI_SMOKE_REUSE_SERVER=1 \
ELIZA_UI_SMOKE_DISABLE_VIDEO=1 \
./packages/app/node_modules/.bin/playwright test \
  --config packages/app/playwright.ui-smoke.config.ts \
  --project=chromium \
  packages/app/test/ui-smoke/settings-audit-capture.spec.ts
```

That produced 32 settings screenshots: hub plus 15 sections at desktop and mobile. One target, `wallet-rpc`, failed in both viewports because `#wallet-rpc` never appeared. This should be treated as a settings navigation/coverage defect, not as a clean pass.

A registered-plugin-view sweep was added for this audit:

```bash
ELIZA_PLUGIN_VIEWS_AUDIT=1 \
ELIZA_UI_SMOKE_REUSE_SERVER=1 \
ELIZA_UI_SMOKE_DISABLE_VIDEO=1 \
ELIZA_UI_SMOKE_CHROMIUM_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
./packages/app/node_modules/.bin/playwright test \
  --config packages/app/playwright.ui-smoke.config.ts \
  --project=chromium \
  packages/app/test/ui-smoke/views-plugin-audit-capture.spec.ts
```

The sweep accounts for all 55 registered plugin view cases at desktop and mobile in `plugin-view-sweep/`. Desktop captured 52 screenshots and recorded 3 capture errors. Mobile captured 42 screenshots and recorded 13 capture errors. Several plugin routes rendered only the shared orange app background in the first pass; direct debug capture of `/contacts` then showed the route falling back to the home/launcher surface while the global background stayed orange. Treat this as view routing/isolation evidence, not as a successful plugin UX pass.

A deeper subview pass was added for this audit and run against the reusable Vite server:

```bash
ELIZA_VIEWS_DEEP_AUDIT=1 \
ELIZA_UI_SMOKE_REUSE_SERVER=1 \
ELIZA_UI_SMOKE_DISABLE_VIDEO=1 \
./packages/app/node_modules/.bin/playwright test \
  --config packages/app/playwright.ui-smoke.config.ts \
  --project=chromium \
  packages/app/test/ui-smoke/views-deep-audit-capture.spec.ts
```

It captured 25 additional screenshots covering wallet tabs, Hyperliquid perps, Polymarket predictions, browser empty/tab/navigation states, launcher pages, and Settings -> Wallet & RPC at desktop/mobile. The first desktop launcher/settings attempt failed on a Settings layout-shift telemetry assertion; a direct settings load then captured the target section.

## Evidence

- Screenshot directory: `.github/issue-evidence/views-ux-audit-2026-07-04/aesthetic-audit-output/`
- Settings subview directory: `.github/issue-evidence/views-ux-audit-2026-07-04/settings-audit/`
- Deep subview directory: `.github/issue-evidence/views-ux-audit-2026-07-04/deep-subviews/`
- Partial plugin-view directory: `.github/issue-evidence/views-ux-audit-2026-07-04/plugin-views/`
- Plugin sweep directory: `.github/issue-evidence/views-ux-audit-2026-07-04/plugin-view-sweep/`
- Settings: `desktop-landscape/builtin-settings.png`, `mobile-portrait/builtin-settings.png`, `mobile-landscape/builtin-settings.png`, `ipad-portrait/builtin-settings.png`
- Settings subviews: `settings-audit/desktop/_hub.png`, `settings-audit/desktop/ai-model.png`, `settings-audit/desktop/advanced.png`, `settings-audit/mobile/_hub.png`, `settings-audit/mobile/ai-model.png`, `settings-audit/mobile/advanced.png`
- Settings Wallet & RPC: `deep-subviews/desktop-settings-wallet-rpc.png`, `deep-subviews/mobile-settings-wallet-rpc.png`
- Browser: `desktop-landscape/builtin-browser.png`, `mobile-portrait/builtin-browser.png`, `mobile-landscape/builtin-browser.png`, `ipad-portrait/builtin-browser.png`
- Browser subviews: `deep-subviews/desktop-browser-empty.png`, `deep-subviews/desktop-browser-example-tab.png`, `deep-subviews/desktop-browser-docs-navigation.png`, `deep-subviews/mobile-browser-empty.png`, `deep-subviews/mobile-browser-example-tab.png`, `deep-subviews/mobile-browser-docs-navigation.png`
- Launcher / apps: `desktop-landscape/builtin-apps.png`, `mobile-portrait/builtin-apps.png`, `mobile-landscape/builtin-apps.png`, `ipad-portrait/builtin-apps.png`
- Launcher pages: `deep-subviews/desktop-launcher-page-0.png`, `deep-subviews/desktop-launcher-page-1.png`, `deep-subviews/mobile-launcher-page-0.png`
- Wallet: `desktop-landscape/builtin-inventory.png`, `mobile-portrait/builtin-inventory.png`, `mobile-landscape/builtin-inventory.png`, `ipad-portrait/builtin-inventory.png`
- Wallet subviews: `deep-subviews/desktop-wallet-tokens.png`, `deep-subviews/desktop-wallet-defi.png`, `deep-subviews/desktop-wallet-nfts.png`, `deep-subviews/desktop-wallet-perps-hyperliquid.png`, `deep-subviews/desktop-wallet-predictions-polymarket.png`, plus mobile equivalents.
- Partial plugin captures: `plugin-views/contacts-gui.png`, `plugin-views/contacts-tui.png`, `plugin-views/hyperliquid-gui.png`
- Plugin sweep manifests: `plugin-view-sweep/desktop-plugin-view-sweep.json`, `plugin-view-sweep/mobile-plugin-view-sweep.json`
- Plugin route fallback/background debug captures: `plugin-view-sweep/debug-contacts-after-wait.png`, `plugin-view-sweep/debug-contacts-seeded.png`

## Executive Read

The app has a strong base: iconography is lively, the floating composer gives continuity, and the launcher has a clear spatial model. The problem is that the shell does not feel authored as one product. It feels like many views each decided what a page is. Headers, back affordances, background policy, density, and layout chrome vary per route.

The most damaging pattern is architectural: views are mounted into one React/DOM/app surface and can opt into shared background behavior. That makes normal app screens visually inherit the launcher wallpaper, and it makes background ownership feel global rather than scoped. The Settings screenshot is the clearest visible failure: a form-heavy preferences page is sitting on the orange launcher background. It reads like a modal accidentally lost its glass, not a deliberate settings surface.

## Cross-View Findings

### 1. View headers are not a system component

Expected normal-view header: back arrow on the left, no button fill/border, view name centered. Fullscreen views can opt out.

Actual:

- Settings has the shell back button plus its own left rail title and per-section icon/title. Mobile sections use a text "Settings" back button with hover background in `SettingsView.tsx`, not the requested bare icon.
- Browser has toolbar controls and URL chrome but no centered view title.
- Wallet uses top tabs and places the route identity in the first tab, not a consistent centered header.
- Launcher has a floating top strip and no consistent centered title.

Code anchors:

- Shell back button: `packages/ui/src/App.tsx`
- Settings custom back and titles: `packages/ui/src/components/pages/SettingsView.tsx`
- Optional per-view `contentHeader` pattern appears across many pages instead of a required normal-view shell contract.

Actionable:

- Introduce one `ViewHeader` contract owned by the shell.
- Each normal view provides `title`, optional `subtitle`, optional right actions, and a `fullscreen` or `chrome: none` opt-out.
- The shell owns the back icon position and behavior; views do not render their own competing page backs.
- Add an audit assertion that normal views expose the same header geometry at desktop/mobile.

### 2. Background ownership leaks across views

Actual screenshots show Settings and Apps using the shared orange launcher background. Wallet and Browser are opaque, which creates a jarring jump between surfaces. The inconsistency is not just aesthetic; it comes from a policy mechanism where background behavior is decided per route/view.

Code anchors:

- `resolveActiveScreenBackgroundPolicy(...)` in `packages/ui/src/App.tsx`
- `AppBackground` mounted at shell root in `packages/ui/src/App.tsx`
- Background event bridge mounted globally in `packages/ui/src/backgrounds/AppBackground.tsx`

Actionable:

- Make opaque, token-backed view background the default for all normal views.
- Restrict shared wallpaper to Home/Launcher/Background and explicitly named immersive/fullscreen views.
- Add a view-isolation boundary that prevents a view from mutating global background/body/root classes except through a shell-owned broker.
- Add a visual audit assertion: navigating from a shared-background view into a normal view must not retain the wallpaper behind content.

### 3. The launcher is charismatic but uncontrolled

The launcher has personality: big icons, strong color, immediate recognizability. It also looks like it was scaled from a phone springboard without enough desktop editorial control.

Visible issues:

- Top strip is a large dark rounded slab with only two items; it feels like a header placeholder rather than a dock or recents rail.
- The grid has inconsistent labels and duplicates (`Fin Tuning`, `Fine-Tuning`, `Fine-Tuning`) that reduce trust.
- Icon styles are fun but not normalized; several icons look like unrelated app-store experiments.
- Large empty bottom area competes with the floating composer instead of giving the grid a resolved rhythm.

Actionable:

- Split launcher into predictable zones: Recents, Favorites, All Apps.
- Normalize icon mask, shadow, label wrapping, and duplicate labels.
- Use stronger desktop layout rules: max grid width, consistent column rhythm, and no oversized empty top strip unless it has a named purpose.
- Add curation lint for duplicate app labels.

### 4. Settings reads like raw configuration, not product-grade preferences

Visible issues:

- Settings sits on the orange wallpaper, reducing contrast and making the form feel exposed.
- The rail and content title fight for hierarchy.
- Form fields are huge relative to the amount of content, but the whole page still feels sparse rather than calm.
- Section back behavior is not aligned with the desired header system.
- Mobile hub content is partially hidden behind the fixed composer; the `Appearance` row is clipped at the bottom of the captured viewport.
- Mobile sections use a tiny inline `Settings` text-back affordance, then a separate section title; this does not read as a product-level navigation bar.
- The initial settings section harness could not resolve `wallet-rpc` by id, even though the nav item was visible. Direct navigation/click did capture Wallet & RPC later, which means the coverage contract and rendered section ids are inconsistent.
- Wallet & RPC shows `HTTP 502` inside the wallet keys panel when no backend is available. That is raw infrastructure leakage in a preferences view.

Actionable:

- Make Settings opaque by default.
- Use the shared normal-view header: centered `Settings`, back icon left.
- Make the selected section title a local content heading, not another page-level header.
- Collapse repeated form spacing into a quiet settings rhythm: label, control, helper text, with consistent max widths.
- Give Wallet & RPC a polished offline/backend-unavailable state with plain-language recovery, not a bare HTTP status.
- Fix the settings section id/anchor contract so `wallet-rpc` can be captured by the generic settings audit.

### 5. Browser is useful but too faint

Visible issues:

- Browser has a lot of low-contrast gray on gray.
- The empty state is centered, but the install bridge panel is low on the page and feels disconnected from the primary "open/search" actions.
- The left sidebar has three empty groups; it communicates absence more than capability.
- There is no view title or consistent product-level header.
- In active-tab states, the desktop browser still has no page title; the tab sidebar and address bar become the entire view identity.
- On mobile, the address field truncates so aggressively that `https://example.com/` becomes visually clipped mid-token; the toolbar controls crowd the first row.
- The floating composer overlaps the browser content area at the bottom, even when a page is loaded.

Actionable:

- Use the shared normal-view header and let browser toolbar sit under it.
- Turn the empty state into one focused composition: URL/search input, primary action, bridge status, then tabs.
- Hide empty tab groups until they contain something or combine them into one empty state.
- Increase contrast for toolbar controls and disabled actions.
- On mobile, allocate stable toolbar widths and collapse secondary controls into an overflow menu rather than crushing the address field.

### 6. Wallet has structure but not enough trust polish

Visible issues:

- The top nav uses tabs as the view title, so the screen lacks a centered identity.
- Balance and chain/account chips are legible, but the colored dots look like placeholders or redacted content.
- Tokens, DeFi, NFTs columns float in too much blank space; the layout lacks a financial-product grid discipline.
- The floating composer occludes the lower portion of the wallet surface.
- Hyperliquid and Polymarket are effectively wallet-family subviews, but they render with their own raw utility chrome instead of a shared wallet header/subnav system.
- Polymarket captured an in-view runtime error: `Cannot read properties of undefined (reading 'ready')`.
- Wallet tabs (Tokens/DeFi/NFTs) expose useful data, but the visual treatment is still closer to a debug sidebar than a trustworthy financial product.

Actionable:

- Use shared header with `Wallet`; keep `Wallet / Perps / Predictions` as secondary nav.
- Replace placeholder/redaction dots with deliberate privacy controls and clear labels.
- Align balances, chains, token rows, and chart space on a tighter financial grid.
- Reserve bottom safe area for the composer or suppress the composer for transactional fullscreen states.
- Bring Wallet, Perps, and Predictions under one consistent wallet-family shell with shared title, secondary nav, loading/error states, and backend-unavailable copy.
- Fix the Polymarket undefined `ready` access and add a visual assertion for the predictions route.

### 7. Plugin views need an offline, routing, and chrome contract

Visible issues from partial captures and the registered-view sweep:

- `/contacts` GUI/TUI did not render a contacts view in the captured state; it fell through to a launcher/home-like app grid while the audit metadata still identified the route as `contacts`.
- `/hyperliquid` rendered useful read-only content, but it looks like a raw utility panel: local `Refresh`, `Home`, and `Back` buttons, status lines, and a bottom full-width orange action without a shared view header or product-level hierarchy.
- The global reconnect banner and floating composer sit on top of plugin surfaces, making plugin views feel like uncontrolled inserts rather than first-class app surfaces.
- Backend unavailability appears as host-level websocket/proxy failure noise, not as a deliberate per-view offline state.
- Desktop plugin sweep accounted for all 55 registered view cases but only 52 produced screenshots; `calendar` GUI and both `model-tester` modes recorded capture errors.
- Mobile plugin sweep accounted for all 55 registered view cases but only 42 produced screenshots. Failures clustered around heavier/dynamic surfaces: `model-tester`, `phone` GUI, `vector-browser`, `feed`, `views-manager`, `screenshare` TUI, `social-alpha` TUI, `task-coordinator` TUI, and `orchestrator` GUI.
- The first bounded sweep produced many orange-only screenshots. A direct seeded debug capture of `/contacts` showed why: the app had rendered the home/launcher surface under the route, with the global body/html background still set to orange. That is both a route-specific rendering failure and a global-background isolation failure.

Actionable:

- Require registered plugin views to declare `title`, `chrome`, `offlineState`, `capabilities`, and `headerPolicy`.
- Add a route assertion that `/contacts` renders contacts-specific content, not the launcher fallback.
- Use shell header/back controls for plugin GUI views unless they explicitly opt into fullscreen/terminal chrome.
- Give plugin views a bounded offline/capability failure state so missing API grants do not leak as global proxy noise.
- Add a capture-readiness marker for plugin views so visual tests wait for actual route content rather than `#root` plus a painted global background.

## Research Notes For Surface Isolation

- Electron documents `WebContentsView` as one of the supported ways to embed web content, and `BrowserView` is deprecated in its favor.
- MDN warns that sandboxed iframes using both `allow-scripts` and `allow-same-origin` on same-origin content can effectively remove the sandbox benefit.
- Android WebView supports multiprocess renderer handling and renderer priority policy; Android's WebView security guidance says modern WebView isolates renderer processes from the host app.
- Apple exposes `WKWebView` / `WKProcessPool`, where process-pool choice controls which web views may share process space.

Implication: separate surfaces are realistic, but the secure architecture needs a broker. Desktop should prefer separate windows or WebContentsView/webview-like surfaces for independent app views. Web can keep in-process rendering for trusted shell views but should use sandboxed iframes for untrusted/plugin/dynamic views, avoiding same-origin+scripting combinations where possible. Mobile should map independent app views to native-managed surfaces/WebViews when isolation or lifecycle matters.

## Verification Gaps

- Plugin views are accounted for in the bounded sweep, but many captures are route fallback/global-background evidence rather than successful plugin content. A clean API-backed run is still needed to evaluate each plugin's intended happy path.
- The generic settings harness still cannot capture `wallet-rpc` through its id/anchor path; direct click capture works and is included.
- Screenshots alone do not verify keyboard focus order, screen-reader semantics, or actual background mutation after user-driven navigation.
