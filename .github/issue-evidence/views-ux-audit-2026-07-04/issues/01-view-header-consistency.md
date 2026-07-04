# Standardize normal-view headers across Settings, Wallet, Browser, Launcher subviews

## Problem

Normal views do not share one view-header contract. The result is visibly inconsistent and makes the app feel assembled from unrelated surfaces.

Expected normal-view header:

- Back arrow on the left.
- Back arrow is just an icon: no border, no filled circle/background.
- View name centered.
- Fullscreen/immersive views may explicitly opt out.

Current examples from the 2026-07-04 audit:

- Settings: `.github/issue-evidence/views-ux-audit-2026-07-04/aesthetic-audit-output/desktop-landscape/builtin-settings.png`
- Settings mobile hub: `.github/issue-evidence/views-ux-audit-2026-07-04/settings-audit/mobile/_hub.png`
- Settings mobile section: `.github/issue-evidence/views-ux-audit-2026-07-04/settings-audit/mobile/ai-model.png`
- Settings Wallet & RPC: `.github/issue-evidence/views-ux-audit-2026-07-04/deep-subviews/desktop-settings-wallet-rpc.png`
- Browser: `.github/issue-evidence/views-ux-audit-2026-07-04/aesthetic-audit-output/desktop-landscape/builtin-browser.png`
- Browser active tab: `.github/issue-evidence/views-ux-audit-2026-07-04/deep-subviews/desktop-browser-example-tab.png`
- Wallet: `.github/issue-evidence/views-ux-audit-2026-07-04/aesthetic-audit-output/desktop-landscape/builtin-inventory.png`
- Wallet Perps: `.github/issue-evidence/views-ux-audit-2026-07-04/deep-subviews/desktop-wallet-perps-hyperliquid.png`
- Launcher/apps: `.github/issue-evidence/views-ux-audit-2026-07-04/aesthetic-audit-output/desktop-landscape/builtin-apps.png`
- Plugin sweep manifest: `.github/issue-evidence/views-ux-audit-2026-07-04/plugin-view-sweep/desktop-plugin-view-sweep.json`

## Evidence

The app currently has multiple header/back patterns:

- `packages/ui/src/App.tsx` owns a shell back button.
- `packages/ui/src/components/pages/SettingsView.tsx` implements `SectionBackButton` with text, hover background, and section-local placement.
- Many pages accept optional `contentHeader`; others render their own local title, toolbar, tabs, or no title at all.

Settings is especially inconsistent: desktop uses a left settings rail plus a section heading; mobile section views add a text "Settings" back button. Neither matches the requested normal-view header.

The focused settings pass captured hub plus 15 settings sections at desktop and mobile. It makes the inconsistency more obvious: mobile settings hub has a large left-offset `Settings` heading with no shell header, while mobile section pages use an inline `← Settings` text button and a separate icon/title row. The expected pattern is one centered view title with one bare left back icon.

The deep subview pass expands the same finding beyond settings. Browser active-tab states use toolbar chrome as page identity. Hyperliquid/Polymarket wallet-family routes render local `Refresh`, `Home`, `Back`, and market controls instead of the same normal-view header. Wallet & RPC has a section-local heading and rail state, but no centered view header.

The registered plugin sweep expands the same issue to dynamic views. Plugin GUI/TUI routes are not required to declare a shell-owned title/back/header policy, so some routes fall back to launcher/home chrome while others render local controls. Header consistency cannot be solved per page; it needs to be part of the view registration contract.

## Proposed Direction

Introduce a shell-owned `ViewHeader` contract:

- `title: string`
- `subtitle?: string`
- `leftAction?: "back" | "close" | "none"`
- `rightActions?: ReactNode`
- `chrome?: "normal" | "fullscreen" | "modal" | "immersive"`

Normal views render through the shell header. FullscreenViews opt out explicitly.

## Acceptance Criteria

- Every normal built-in view has the same header geometry at desktop, tablet, and mobile.
- Header back affordance is icon-only, left-aligned, and has no border/background in rest state.
- View title is centered in the header.
- Settings section back uses the shared shell header, not a section-local text button.
- Browser toolbar sits below the header rather than replacing it.
- Wallet top tabs become secondary nav under the `Wallet` header.
- `audit:app` or an equivalent visual assertion fails when a normal view lacks the shared header.
- Registered plugin GUI views declare `headerPolicy` and either render through the shared normal-view header or explicitly opt into fullscreen/terminal chrome.

## Evidence Gaps / Known Defects

- Generic `wallet-rpc` settings capture by id still fails, but direct navigation/click now captures Wallet & RPC at desktop/mobile. The section id/anchor contract needs repair.
- Plugin-view happy-path header coverage still needs an API-backed/offline-capability-clean run. The bounded sweep now accounts for every registered route, but several captures are fallback/background evidence rather than intended plugin content.
