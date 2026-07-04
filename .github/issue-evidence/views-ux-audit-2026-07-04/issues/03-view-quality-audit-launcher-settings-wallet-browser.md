# Product-quality audit: launcher, settings, wallet, and browser views need a cohesive design pass

## Audit Evidence

Current-run evidence directory:

`.github/issue-evidence/views-ux-audit-2026-07-04/aesthetic-audit-output/`

Focused settings evidence:

`.github/issue-evidence/views-ux-audit-2026-07-04/settings-audit/`

Deep subview evidence:

`.github/issue-evidence/views-ux-audit-2026-07-04/deep-subviews/`

Partial plugin-view evidence:

`.github/issue-evidence/views-ux-audit-2026-07-04/plugin-views/`

Report:

`.github/issue-evidence/views-ux-audit-2026-07-04/REPORT.md`

The broad audit captured 121 route-level screenshots before the run was terminated. It includes desktop, mobile portrait, mobile landscape, and iPad portrait for built-in views through logs. A focused settings pass captured 32 additional settings screenshots: hub plus 15 sections at desktop and mobile. A deep-subview pass captured 25 more screenshots for wallet tabs, perps, predictions, browser tab states, launcher pages, and Settings -> Wallet & RPC. A plugin pass captured three screenshots before repeated API-unavailable failures made the run non-actionable.

## Overall Product Read

There is personality here, especially in the launcher icons and the floating composer. But the app does not feel like one designed system yet. It has a lot of local decisions: view-by-view headers, background policies, density, navigation, and empty states. The product quality issue is not "make it prettier"; it is that the app lacks a coherent view grammar.

## Launcher / Apps

Screenshot:

`.github/issue-evidence/views-ux-audit-2026-07-04/aesthetic-audit-output/desktop-landscape/builtin-apps.png`

Issues:

- The top strip is a huge dark rounded slab with only two items; it feels like an unfinished dock.
- Duplicate and inconsistent labels (`Fin Tuning`, `Fine-Tuning`, `Fine-Tuning`) make the launcher look sloppy.
- Icon styles vary wildly. Playful is good; ungoverned is not.
- Desktop grid rhythm leaves too much unresolved orange space.

Actionables:

- Create named zones: Recents, Favorites, All Apps.
- Normalize icon masks, label width, shadow, and truncation.
- Add a launcher label-duplication lint/check.
- Reduce the empty top slab unless it has a real role.

## Settings

Screenshot:

`.github/issue-evidence/views-ux-audit-2026-07-04/aesthetic-audit-output/desktop-landscape/builtin-settings.png`

Additional settings screenshots:

- `.github/issue-evidence/views-ux-audit-2026-07-04/settings-audit/desktop/_hub.png`
- `.github/issue-evidence/views-ux-audit-2026-07-04/settings-audit/desktop/advanced.png`
- `.github/issue-evidence/views-ux-audit-2026-07-04/settings-audit/mobile/_hub.png`
- `.github/issue-evidence/views-ux-audit-2026-07-04/settings-audit/mobile/ai-model.png`
- `.github/issue-evidence/views-ux-audit-2026-07-04/deep-subviews/desktop-settings-wallet-rpc.png`
- `.github/issue-evidence/views-ux-audit-2026-07-04/deep-subviews/mobile-settings-wallet-rpc.png`

Issues:

- Preferences sit directly on the orange launcher wallpaper, which feels accidental and lowers perceived seriousness.
- Rail title, section icon/title, and shell back compete.
- Forms are very large but not calm; the page is sparse without feeling designed.
- Mobile section back is a custom text button, not the desired shared header.
- Mobile settings hub is clipped by the floating composer; the lower rows are visually trapped behind global shell chrome.
- The generic settings capture could not navigate to `wallet-rpc` by section id, even though direct click capture works. The settings IA and anchor/ID contract are inconsistent.
- Wallet & RPC shows raw `HTTP 502` text in the wallet keys panel instead of a product-grade backend unavailable state.

Actionables:

- Make Settings opaque by default.
- Use shared normal-view header with centered `Settings`.
- Treat section title as content, not another page header.
- Standardize field max widths, label/control spacing, helper text, and section rhythm.
- Reserve composer/safe-area space for settings or suppress the composer while editing preferences.
- Fix the `wallet-rpc` section target/id and keep it in the settings visual capture acceptance list.
- Replace raw wallet-key HTTP errors with calm recovery copy and a retry affordance.

## Browser

Screenshot:

`.github/issue-evidence/views-ux-audit-2026-07-04/aesthetic-audit-output/desktop-landscape/builtin-browser.png`

Additional browser screenshots:

- `.github/issue-evidence/views-ux-audit-2026-07-04/deep-subviews/desktop-browser-empty.png`
- `.github/issue-evidence/views-ux-audit-2026-07-04/deep-subviews/desktop-browser-example-tab.png`
- `.github/issue-evidence/views-ux-audit-2026-07-04/deep-subviews/mobile-browser-example-tab.png`

Issues:

- The surface is too low-contrast: gray text, gray chrome, gray page.
- Empty left groups say "No User Tabs / No Agent Tabs / No App Tabs" instead of helping the user start.
- The bridge install panel is visually detached from the main action.
- The browser toolbar replaces the view header rather than living under it.
- In active-tab states, the browser still has no stable page title; the address bar becomes the header.
- Mobile active-tab state crushes the address field; `https://example.com/` is visibly clipped.

Actionables:

- Add shared `Browser` header.
- Collapse empty tab groups into one helpful empty state until tabs exist.
- Bring bridge status/action closer to the primary open/search flow.
- Increase contrast and simplify disabled action language.
- Give mobile browser a real responsive toolbar: preserve address readability, move secondary controls to overflow, and keep the view title/header stable.

## Wallet

Screenshot:

`.github/issue-evidence/views-ux-audit-2026-07-04/aesthetic-audit-output/desktop-landscape/builtin-inventory.png`

Additional wallet screenshots:

- `.github/issue-evidence/views-ux-audit-2026-07-04/deep-subviews/desktop-wallet-tokens.png`
- `.github/issue-evidence/views-ux-audit-2026-07-04/deep-subviews/desktop-wallet-defi.png`
- `.github/issue-evidence/views-ux-audit-2026-07-04/deep-subviews/desktop-wallet-nfts.png`
- `.github/issue-evidence/views-ux-audit-2026-07-04/deep-subviews/desktop-wallet-perps-hyperliquid.png`
- `.github/issue-evidence/views-ux-audit-2026-07-04/deep-subviews/desktop-wallet-predictions-polymarket.png`

Issues:

- The view title is a selected tab, not a stable centered header.
- Redacted-looking dots and floating chain chips reduce financial trust.
- Token rows, portfolio summary, tabs, and chart area do not share a tight financial grid.
- The floating composer sits over the bottom of a transactional surface.
- Perps and Predictions are wallet-family surfaces but use their own raw utility chrome instead of a shared Wallet shell.
- Polymarket captured an in-view runtime error: `Cannot read properties of undefined (reading 'ready')`.

Actionables:

- Add shared `Wallet` header and move Wallet/Perps/Predictions into secondary nav.
- Replace placeholder/redaction dots with intentional privacy controls.
- Align balances, account chips, token rows, and chart controls to a tighter grid.
- Reserve bottom safe area for the composer or suppress it for transaction-critical states.
- Fix Polymarket's undefined `ready` access and add visual coverage for the error-free predictions route.
- Bring Wallet/Perps/Predictions under one wallet-family information architecture.

## Plugin / Dynamic Views

Screenshots:

- `.github/issue-evidence/views-ux-audit-2026-07-04/plugin-views/contacts-gui.png`
- `.github/issue-evidence/views-ux-audit-2026-07-04/plugin-views/hyperliquid-gui.png`

Issues:

- `/contacts` was captured as a launcher/home-like grid, not a contacts experience. That is either route fallback leakage or an insufficient offline state.
- `/hyperliquid` contains useful read-only data but reads as raw utility output, with local `Refresh`, `Home`, and `Back` buttons competing with shell navigation.
- Plugin views inherit global reconnect/composer chrome without enough surface negotiation.
- API-unavailable errors show up as host websocket/proxy failure noise instead of a deliberate plugin offline state.

Actionables:

- Require plugin view metadata for title, header policy, offline state, and granted capabilities.
- Add assertions that registered routes render route-specific content.
- Normalize plugin GUI chrome through the shell header unless the view opts into fullscreen/terminal mode.
- Provide a bounded no-backend state for plugin/dynamic views.

## Acceptance Criteria

- A designer/reviewer can scan the four screenshots and identify one consistent shell.
- Header, background, nav, and empty-state patterns are documented and enforced by view metadata.
- `audit:app` screenshots for launcher/settings/browser/wallet are manually reviewed and no longer sit at `needs-eyeball`.
- Settings capture includes every cataloged settings section, including `wallet-rpc`, at desktop and mobile.
- Deep subview capture includes wallet Tokens/DeFi/NFTs, Perps, Predictions, browser empty/active states, and launcher pages at desktop/mobile where available.
- Registered plugin view screenshots can be captured without API-unavailable proxy noise, or the test harness provides an intentional offline visual state.
- `/contacts` renders a contacts-specific view, not the launcher fallback.
- Duplicate launcher labels are removed.
- Settings, Browser, and Wallet each have a coherent first-run/empty state and desktop/mobile layouts.
