# 9945 — Settings/Views subview deep-link + orientation

## Orientation evidence (`audit:app`)

The audit walks every view at all four `{desktop,mobile}×{portrait,landscape}` viewports
(VIEWPORTS extended in `all-views-aesthetic-audit.spec.ts`). **208 specs passed, 0 broken.**
Settings renders correctly at every orientation — verdict **good** for all four:

| File | Viewport | Layout | Verdict |
|---|---|---|---|
| `settings-desktop.png` | 1440×1000 | two-pane (nav + detail) | good |
| `settings-desktop-portrait.png` | 1024×1366 | two-pane (width ≥1024) | good |
| `settings-mobile.png` | 390×844 | single-column hub | good |
| `settings-mobile-landscape.png` | 844×390 | **two-pane** | good |

**The fix in one frame:** `settings-mobile-landscape.png` (a landscape *phone*, 844px wide) now
uses the **two-pane** layout via `isWideLandscape = (min-width:768px) and (orientation:landscape)`.
Before this PR the lone `min-width:1024px` lever forced an 844px landscape phone into the cramped
single-column hub. Portrait phone (`settings-mobile.png`) correctly stays a single-column hub.

## Subview deep-link

Functional proof is the `plugin-app-control` `views-subview` unit suite (8/8) + the
`deterministic-settings-subview` scenario: a `VIEWS action=show view=settings subview=<token>`
resolves the token (`model`→`ai-model`) and the navigate POST to `/api/views/settings/navigate`
carries the resolved `subview`, which `views-routes.ts` parses, `[ViewsRoutes]`-logs, and broadcasts
into `SettingsView`'s `initialSection`.
