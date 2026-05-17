# BRAND-TODO

Canonical follow-up list for the multi-round Eliza brand redesign. Consolidates every deferred item from prior agents (designer asset lists, in-code `TODO(brand)` comments, accessibility audit, product-flow walk, hardware-preorder review, checkpoint commits).

## Where the redesign stands

Five primary surfaces have been redesigned end-to-end against the Eliza brand (white logo on `#FF5800`, Poppins, sharp corners on marketing / xs-rounding inside chat, dark in-product chrome). Three brand themes are wired (`theme-app` orange marketing, dark in-product, light dashboard transitional). The `<CloudVideoBackground>` clouds-as-background treatment is live on the primary surfaces, and a `@elizaos/shared-brand` package now centralises tokens, OG embed SVGs, and the logo. What remains is a long tail of binary assets that only a designer can regenerate, a handful of product-flow gaps where the dark-themed chat loop doesn't close inside Eliza Cloud, duplication across the hardware-preorder catalog, and a small accessibility polish list.

---

## Product gaps (dark-theme chat loop, agent creation flow)

- [ ] **Close the in-app chat loop after creating a cloud agent.** Today the post-create CTA opens an external "Web UI" popup. `/chat/:characterRef` requires a `username` for a public character, and newly-created cloud agents don't get one, so the loop never closes inside Eliza Cloud. Either auto-assign a `username` on create or render an in-app chat panel that accepts the agent id. — `cloud-frontend/src/pages/agents/*`, `cloud-api` agent-create route. — **L** — Shaw + frontend
- [ ] **Replace `/dashboard/chat` redirect.** It currently `Navigate`s to `/dashboard/my-agents`, which is a light-theme overview, not a chat surface. Either route to a real chat surface or remove the dead route. — `cloud-frontend/src/pages/dashboard/chat.tsx` — **S** — frontend
- [ ] **Rebrand or retire `AgentConsoleOverview` (`my-agents.tsx`).** Fully light-theme block inside an otherwise dark dashboard, side-path that the redesign skipped. — `cloud-frontend/src/pages/dashboard/my-agents.tsx` — **M** — frontend
- [ ] **xs-rounding pass on `eliza-chat-interface.tsx`.** 26 instances of `rounded-lg` / `rounded-xl` to bring down to the brand's tighter chat-bubble radius. — `cloud-frontend/src/components/chat/eliza-chat-interface.tsx` — **S** — frontend
- [ ] **Add a character-pick step to `CreateElizaAgentDialog`.** Currently asks for name + flavor only. If "pick a character" is part of the product vision, adding it would give the created agent a `username` and make `/chat/@username` resolve. — `cloud-frontend/src/components/agents/create-eliza-agent-dialog.tsx` — **M** — Shaw (product call) → frontend
- [ ] **Resolve the `theme-app` onboarding-marketing TODO in `packages/app/src/main.tsx:309`.** When `@elizaos/ui`'s onboarding component gains an explicit "marketing theme" preset, point `APP_BRANDING.onboardingTheme` at it here. Currently a `TODO(brand)` comment. — `packages/app/src/main.tsx:309` — **S** — frontend (blocked on `@elizaos/ui`)

---

## Hardware preorder catalog (consolidation)

- [ ] **Orphan SKU `elizaos-usb-plastic`.** Listed in the `cloud-api` Zod enum but has no homepage tile. Either add a tile or remove the enum value. — `cloud-api/src/routes/stripe/create-checkout-session/route.ts`, `os-homepage/src/App.tsx` — **S** — backend or product call (Shaw)
- [ ] **Consolidate hardware product catalog into `@elizaos/hardware-catalog`.** Catalog is triplicated across `os-homepage/src/App.tsx`, `cloud-frontend/src/pages/checkout/page.tsx`, and `cloud-api/.../create-checkout-session/route.ts`. Single shared package with typed SKUs, names, prices, and image refs. — new package `packages/hardware-catalog` — **M** — frontend + backend
- [ ] **Consolidate `CheckoutPage` between os-homepage and cloud-frontend.** Duplicated logic for the same flow. — `apps/os-homepage/src/...`, `cloud-frontend/src/pages/checkout/page.tsx` — **M** — frontend

---

## Native binary assets (designer regeneration required)

All from `/brand/logos/logo_white_orangebg.svg` — white Eliza logo, centered, on a solid `#FF5800` field, square unless noted. The text-level theme config and storyboard backdrops are already on brand; only these PNGs (and one foreground drawable) carry stale visual content.

### iOS

- [ ] **iOS Splash imageset (3 PNGs).** `packages/app/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png`, `…-1.png`, `…-2.png`. — **S** — designer
- [ ] **iOS AppIcon imageset (~18 PNGs).** `packages/app/ios/App/App/Assets.xcassets/AppIcon.appiconset/*`. `AppIcon-ios-marketing-1024.png` is the master; the rest scale down. — **M** — designer
- [ ] **iOS public web icons.** `apple-touch-icon.png`, `android-chrome-192x192.png`, `android-chrome-512x512.png`, `favicon-16x16.png`, `favicon.ico`, `og-image.png` (1200×630) under `packages/app/ios/App/App/public/`. — **S** — designer

### Android

- [ ] **Android splash PNGs (~11 files).** All densities, portrait + landscape, under `packages/app/android/app/src/main/res/drawable*`. — **M** — designer
- [ ] **Android adaptive launcher foregrounds + legacy icons (~5 densities).** `mipmap-*/ic_launcher_foreground.png`, `mipmap-*/ic_launcher.png`, `mipmap-*/ic_launcher_round.png`. `drawable/ic_launcher_background.xml` already encodes `#FF5800`; foregrounds need a white Eliza glyph that fits the adaptive-icon safe-area (66dp of 108dp). — **M** — designer

### Web / shared

- [ ] **Root `packages/app/public/og-image.png` — 1200×630 white logo on orange.** — **S** — designer
- [ ] **Per-site OG PNGs.** Currently SVG only in `shared-brand` OG embeds. Twitter/X accepts SVG; LinkedIn and Facebook prefer PNG. Generate 1200×630 PNGs from each site's OG embed SVG. — `packages/shared-brand/og/*` — **S** — designer or scriptable export

---

## Accessibility polish

- [ ] **Contrast on `text-white/45` eyebrow label.** Below WCAG AA on the orange background. Needs designer call on what shade keeps the visual hierarchy. — `cloud-frontend/src/pages/sensitive-requests/[requestId]/page.tsx:298` — **S** — designer + frontend
- [ ] **Focus ring `focus:ring-black/30` on orange background.** Borderline visibility. — `cloud-frontend/src/components/.../connected.tsx:227` — **S** — designer + frontend
- [ ] **Color-swatch focus state in checkout.** Designer to confirm focus visibility on the swatch picker. — `cloud-frontend/src/pages/checkout/page.tsx:295` — **S** — designer
- [ ] **`landing-page-new.tsx` skip-link.** Page wraps everything in `<div>` instead of `<main>`; adding a skip-link requires the structural change first. — `apps/os-homepage/src/.../landing-page-new.tsx` — **S** — frontend

---

## Out-of-scope packages (deferred)

- [ ] **Wire `<CloudVideoBackground>` inside `@elizaos/ui` `App.tsx`.** The actual first-rendered React surface ("home screen" before an agent is connected) lives in `packages/ui/src/App.tsx` and the `AppProvider` / `AppWorkspaceChrome` orchestration around it. The shell can't reach it. A round-2 agent is on this. — `packages/ui/src/App.tsx`, `packages/ui/src/backgrounds/CloudVideoBackground.tsx`, also touches `@elizaos/app-core` — **M** — frontend
- [ ] **Electrobun window background.** Brand the native window chrome. — `packages/app-core/platforms/electrobun/*` — **S** — frontend
- [ ] **`homepage/src/pages/leaderboard.tsx` (1613 LOC).** Misnamed onboarding flow. Replace its `ShaderBackground` with a flat brand color per step without breaking the state machine. Round-2 agent assigned. — `apps/homepage/src/pages/leaderboard.tsx` — **L** — frontend

---

## Tooling / external

- [ ] **Mintlify deep customization tracking.** Code-block fill, navbar typography, sidebar typography are currently overridden via `!important` in `style.css` because the Mintlify schema doesn't expose direct toggles. Track upstream — drop the overrides when Mintlify adds first-class support. — `docs/style.css` — **S** (ongoing) — frontend

---

## Done in this redesign

So the next person doesn't redo work:

- `@elizaos/shared-brand` package established — brand tokens, logo SVG (`logo_white_orangebg.svg`), OG embed SVGs, fonts (Poppins).
- Three brand themes wired: `theme-app` (orange marketing), in-product dark, transitional light dashboard.
- `<CloudVideoBackground>` clouds-as-background component built and deployed on the five primary surfaces.
- Five primary surfaces redesigned end-to-end: marketing homepage, cloud-frontend top-level dashboards, checkout page, sensitive-requests page, agent-list dashboard chrome.
- A11y pass completed for the primary surfaces (residual items above are the leftovers).
- Hardware-preorder homepage tiles rebranded (consolidation of the catalog code is what remains).
- Android `drawable/ic_launcher_background.xml` already encodes `#FF5800` — foregrounds are the only piece left for Android icons.
- `packages/app/BRAND-TODO.md` was the designer-asset source list; this document supersedes it (kept in place for designer convenience).
- `TODO(brand)` source comments tracked: `packages/app/src/main.tsx:309` (onboarding-theme preset, listed above).
