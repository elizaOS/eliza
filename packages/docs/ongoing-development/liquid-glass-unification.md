# Liquid-glass unification

One glass vocabulary for every piece of translucent chrome — menus, the chat
sheet, notification cards, pills/buttons, banners — with REAL system glass on
platforms that have it and a graceful CSS fallback everywhere else.

## Where this started

An audit of the shell found **ten divergent surface recipes**: four blur
strengths (12+sat1.5 / 16+sat1.4 / 20 / blur-xl / blur-md), five translucent
dark fills (`var(--card)` 86% / `12 12 14` 34% / black 35 / black 55 / black
85), three border idioms (specular rim ring vs `border-white/N` vs token
`border-border`), and radii from `rounded-sm` to `rounded-3xl`. The optical
core already existed — `components/shell/liquid-glass.tsx` (rim ring, sheen,
inset edge shadow, Chromium `feDisplacementMap` edge refraction) — but only the
chat sheet and notification cards used it, each with hand-tuned numbers.

## The system (`packages/ui/src/glass/`)

- **`tokens.ts`** — five variants mapping to a surface's physical role, not a
  component: `sheet` (large panel, heavy blur, no saturate — saturate reads
  brown over the warm theme), `card` (small floating card, refraction-eligible,
  rim), `pill` (compact control, rim, interactive), `menu` (popover chrome,
  darker fill), `banner` (toast, higher-opacity fill, no rim).
- **`GlassSurface`** — the one primitive: `<GlassSurface variant="menu">`.
  `GlassStyles` mounts the shared stylesheet + refraction defs once per
  document (App root, next to `AppBackground`).
- **`useNativeGlass`** — the tier probe: `native` → `css-refraction`
  (Chromium `@supports (backdrop-filter: url(#x))`) → `css-frosted`
  (universal). Resolves synchronously to a CSS tier and upgrades to native
  async — no flash, no layout shift.
- **`native-bridge.ts` + `GlassBridge.swift` + `GlassBridgePlugin.java`** —
  real native material on both mobile platforms, one JS API. The Swift plugin
  (`packages/app-core/platforms/ios/App/App/GlassBridge.swift`, same
  registration pattern as `ElizaKeyboardBridge`) attaches a
  `UIVisualEffectView(UIGlassEffect)` **below the webview**, anchored to a
  web-reported rect, and flips the webview transparent on first attach. Gated
  `#if compiler(>=6.2)` + `if #available(iOS 26, *)`. The Java plugin
  (`packages/app-core/platforms/android/.../GlassBridgePlugin.java`,
  registered in `MainActivity`) mirrors the API with a Material
  dynamic-palette panel, gated on API 31+. On anything older on either
  platform, `isAvailable()` answers false and every surface stays on its CSS
  tier. Reads the bridge-injected `globalThis.Capacitor` — never a static
  `@capacitor/core` import (`@elizaos/ui` is loaded server-side, #15221).

## The honest native-glass constraint

True glass never renders **inside** the DOM — WKWebView composites its own
pixels. Native glass is a system view layered with the webview, position-synced
from web rects on mount/resize (not per scroll frame). So the native tier is
for **stable chrome only**: the composer pill, a sheet at rest, menus, headers.
Content inside scrollers keeps CSS glass on every platform.

Findings that shaped this (2026-07 research):

- **Capacitor 9.0.0-alpha.5 ships nothing glass-related** (its notes: a merge
  fix, an android verify-script fix, CLI imports). `UIGlassEffect` needs the
  Xcode 26 SDK, not a Capacitor version — we stay on Capacitor 8 stable and
  compile the plugin with availability guards. Revisit Capacitor 9 at stable
  for the Android edge-to-edge work, not for glass.
- **`@capgo/capacitor-native-navigation`** offers native nav/tab bars with
  system glass on Capacitor 8; it takes ownership of chrome our React shell
  renders, so adopting it is a product decision, deferred.
- The RN reference (callstack/liquid-glass) maps `tintColor` /
  `interactive` / `colorScheme` onto `UIGlassEffect`; `interactive` is
  mount-time-only — our bridge mirrors that contract.
- Electrobun desktop (macOS) is not Capacitor; real `NSGlassEffectView` there
  is a separate native-shell work item. Android now has bridge parity (the
  Material dynamic-palette panel, API 31+) instead of staying CSS-only.

## Migration state

| Surface | State |
| --- | --- |
| Notification cards | already on the liquid-glass optical stack (shade v4) |
| Chat sheet | already on sheet-tier numbers; tokens now canonical in `glass/tokens.ts` |
| + menu (chat composer) | migrated — `DropdownMenuContent glass` → `menu` variant |
| Other dropdowns/popovers (slash menu, config selects) | pending — same `glass` prop |
| ViewHeader back button / pills | pending — `pill` variant |
| NotificationBanners (toasts) | pending — `banner` variant |
| `HOME_GLASS_CLASS` / `WALLPAPER_GLASS` family | pending consolidation into tokens |
| Native tier wiring (attach pill/sheet regions) | plugin + probe shipped on iOS AND Android (device e2e: `packages/app/test/android/glass-bridge.android.spec.ts`); surface adoption blocked on native-hosted wallpaper — design + workplan in #15891 |

Each pending row is a small mechanical PR: swap the hand-rolled recipe for a
variant, delete the local numbers, screenshot before/after.
