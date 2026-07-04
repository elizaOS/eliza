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
- Browser: `.github/issue-evidence/views-ux-audit-2026-07-04/aesthetic-audit-output/desktop-landscape/builtin-browser.png`
- Wallet: `.github/issue-evidence/views-ux-audit-2026-07-04/aesthetic-audit-output/desktop-landscape/builtin-inventory.png`
- Launcher/apps: `.github/issue-evidence/views-ux-audit-2026-07-04/aesthetic-audit-output/desktop-landscape/builtin-apps.png`

## Evidence

The app currently has multiple header/back patterns:

- `packages/ui/src/App.tsx` owns a shell back button.
- `packages/ui/src/components/pages/SettingsView.tsx` implements `SectionBackButton` with text, hover background, and section-local placement.
- Many pages accept optional `contentHeader`; others render their own local title, toolbar, tabs, or no title at all.

Settings is especially inconsistent: desktop uses a left settings rail plus a section heading; mobile section views add a text "Settings" back button. Neither matches the requested normal-view header.

The focused settings pass captured hub plus 15 settings sections at desktop and mobile. It makes the inconsistency more obvious: mobile settings hub has a large left-offset `Settings` heading with no shell header, while mobile section pages use an inline `← Settings` text button and a separate icon/title row. The expected pattern is one centered view title with one bare left back icon.

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

## Evidence Gaps / Known Defects

- `wallet-rpc` settings did not capture in either desktop or mobile: `#wallet-rpc` never appeared for the settings audit harness.
- Full plugin-view header coverage is still missing because registered plugin routes hit API proxy failures without a running API server.
