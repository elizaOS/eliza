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

A registered-plugin-view screenshot pass was attempted. It captured `contacts` GUI/TUI and `hyperliquid` GUI screenshots, then was stopped because each view was failing on repeated `502 Bad Gateway` and `ws://127.0.0.1:31337/ws` connection-refused errors. Starting the full dev stack to provide the API then failed with `ENOSPC` while Bun extracted packages. Plugin-view coverage therefore remains blocked by the local disk/API startup state.

## Evidence

- Screenshot directory: `.github/issue-evidence/views-ux-audit-2026-07-04/aesthetic-audit-output/`
- Settings subview directory: `.github/issue-evidence/views-ux-audit-2026-07-04/settings-audit/`
- Partial plugin-view directory: `.github/issue-evidence/views-ux-audit-2026-07-04/plugin-views/`
- Settings: `desktop-landscape/builtin-settings.png`, `mobile-portrait/builtin-settings.png`, `mobile-landscape/builtin-settings.png`, `ipad-portrait/builtin-settings.png`
- Settings subviews: `settings-audit/desktop/_hub.png`, `settings-audit/desktop/ai-model.png`, `settings-audit/desktop/advanced.png`, `settings-audit/mobile/_hub.png`, `settings-audit/mobile/ai-model.png`, `settings-audit/mobile/advanced.png`
- Browser: `desktop-landscape/builtin-browser.png`, `mobile-portrait/builtin-browser.png`, `mobile-landscape/builtin-browser.png`, `ipad-portrait/builtin-browser.png`
- Launcher / apps: `desktop-landscape/builtin-apps.png`, `mobile-portrait/builtin-apps.png`, `mobile-landscape/builtin-apps.png`, `ipad-portrait/builtin-apps.png`
- Wallet: `desktop-landscape/builtin-inventory.png`, `mobile-portrait/builtin-inventory.png`, `mobile-landscape/builtin-inventory.png`, `ipad-portrait/builtin-inventory.png`
- Partial plugin captures: `plugin-views/contacts-gui.png`, `plugin-views/contacts-tui.png`, `plugin-views/hyperliquid-gui.png`

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
- `wallet-rpc` is advertised in the settings section catalog but was not reachable by the settings capture harness in either desktop or mobile.

Actionable:

- Make Settings opaque by default.
- Use the shared normal-view header: centered `Settings`, back icon left.
- Make the selected section title a local content heading, not another page-level header.
- Collapse repeated form spacing into a quiet settings rhythm: label, control, helper text, with consistent max widths.

### 5. Browser is useful but too faint

Visible issues:

- Browser has a lot of low-contrast gray on gray.
- The empty state is centered, but the install bridge panel is low on the page and feels disconnected from the primary "open/search" actions.
- The left sidebar has three empty groups; it communicates absence more than capability.
- There is no view title or consistent product-level header.

Actionable:

- Use the shared normal-view header and let browser toolbar sit under it.
- Turn the empty state into one focused composition: URL/search input, primary action, bridge status, then tabs.
- Hide empty tab groups until they contain something or combine them into one empty state.
- Increase contrast for toolbar controls and disabled actions.

### 6. Wallet has structure but not enough trust polish

Visible issues:

- The top nav uses tabs as the view title, so the screen lacks a centered identity.
- Balance and chain/account chips are legible, but the colored dots look like placeholders or redacted content.
- Tokens, DeFi, NFTs columns float in too much blank space; the layout lacks a financial-product grid discipline.
- The floating composer occludes the lower portion of the wallet surface.

Actionable:

- Use shared header with `Wallet`; keep `Wallet / Perps / Predictions` as secondary nav.
- Replace placeholder/redaction dots with deliberate privacy controls and clear labels.
- Align balances, chains, token rows, and chart space on a tighter financial grid.
- Reserve bottom safe area for the composer or suppress the composer for transactional fullscreen states.

### 7. Plugin views need an offline and chrome contract

Visible issues from partial captures:

- `/contacts` GUI/TUI did not render a contacts view in the captured state; it fell through to a launcher/home-like app grid while the audit metadata still identified the route as `contacts`.
- `/hyperliquid` rendered useful read-only content, but it looks like a raw utility panel: local `Refresh`, `Home`, and `Back` buttons, status lines, and a bottom full-width orange action without a shared view header or product-level hierarchy.
- The global reconnect banner and floating composer sit on top of plugin surfaces, making plugin views feel like uncontrolled inserts rather than first-class app surfaces.
- Backend unavailability appears as host-level websocket/proxy failure noise, not as a deliberate per-view offline state.

Actionable:

- Require registered plugin views to declare `title`, `chrome`, `offlineState`, `capabilities`, and `headerPolicy`.
- Add a route assertion that `/contacts` renders contacts-specific content, not the launcher fallback.
- Use shell header/back controls for plugin GUI views unless they explicitly opt into fullscreen/terminal chrome.
- Give plugin views a bounded offline/capability failure state so missing API grants do not leak as global proxy noise.

## Research Notes For Surface Isolation

- Electron documents `WebContentsView` as one of the supported ways to embed web content, and `BrowserView` is deprecated in its favor.
- MDN warns that sandboxed iframes using both `allow-scripts` and `allow-same-origin` on same-origin content can effectively remove the sandbox benefit.
- Android WebView supports multiprocess renderer handling and renderer priority policy; Android's WebView security guidance says modern WebView isolates renderer processes from the host app.
- Apple exposes `WKWebView` / `WKProcessPool`, where process-pool choice controls which web views may share process space.

Implication: separate surfaces are realistic, but the secure architecture needs a broker. Desktop should prefer separate windows or WebContentsView/webview-like surfaces for independent app views. Web can keep in-process rendering for trusted shell views but should use sandboxed iframes for untrusted/plugin/dynamic views, avoiding same-origin+scripting combinations where possible. Mobile should map independent app views to native-managed surfaces/WebViews when isolation or lifecycle matters.

## Verification Gaps

- Full plugin views were not captured because plugin routes repeatedly hit Vite-proxied API failures (`502 Bad Gateway`, websocket connection refused) and the full API dev stack then failed to start due to `ENOSPC`.
- `wallet-rpc` settings was not captured because the expected `#wallet-rpc` section never appeared.
- Screenshots alone do not verify keyboard focus order, screen-reader semantics, or actual background mutation after user-driven navigation.
