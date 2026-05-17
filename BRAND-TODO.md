# BRAND-TODO

Canonical follow-up list for the multi-round Eliza brand redesign. Consolidates every deferred item from prior agents (designer asset lists, in-code `TODO(brand)` comments, accessibility audit, product-flow walk, hardware-preorder review, checkpoint commits, and rounds 4–7 follow-ups).

## Where the redesign stands

Five primary surfaces have been redesigned end-to-end against the Eliza brand (white logo on `#FF5800`, Poppins, sharp corners on marketing / xs-rounding inside chat, dark in-product chrome). Three brand themes are wired (`theme-app` orange marketing, dark in-product, light dashboard transitional). The `<CloudVideoBackground>` clouds-as-background treatment is live on the primary surfaces, and a `@elizaos/shared-brand` package now centralises tokens, OG embed SVGs, and the logo. Rounds 4–7 closed the in-app chat loop, deduplicated the hardware catalog into `@elizaos/hardware-catalog`, extracted `@elizaos/checkout-shared`, finished the a11y polish for primary surfaces, and tokenized CSS literals across the homepage / os-homepage / docs / tails greeter. Remaining work splits into: a long tail of binary PNG assets only a designer can regenerate, a newly-discovered SSO/security audit list, a build-performance audit, and the always-deferred sibling-agent surfaces.

---

## Security (SSO / auth — new from this round)

- [ ] **Refresh tokens passed via URL query.** `elizaos.ai/checkout?token=...&refreshToken=...` leaks tokens to referer headers, browser history, and any in-page analytics. Move to `#fragment` minimum, or do a server-side nonce exchange. — `cloud-frontend` checkout entry + Steward redirect — **M** — backend + frontend
- [x] **Refresh tokens in localStorage.** ~~XSS-reachable; defeats the HttpOnly cookie protection elsewhere in the system.~~ **Mitigated.** Refresh tokens are no longer written to localStorage on any login path (`os-homepage` + `cloud-frontend`). The HttpOnly `steward-refresh-token` cookie (set by `/api/auth/steward-session` and `/api/auth/steward-nonce-exchange` on `.elizacloud.ai`) is the only persistence. Session rotation now goes through a new `POST /api/auth/steward-refresh` route that reads the cookie server-side and mints new HttpOnly cookies; no token ever appears in the response body. `read/writeStoredStewardRefreshToken()` helpers are marked `@deprecated` with a console warning on call and `writeStoredStewardRefreshToken()` is now a no-op — the localStorage key constant is retained for one release window so legacy tabs can still be cleaned up via `clearStoredStewardToken()`, then both can be deleted.
- [ ] **No origin/referer check on `POST /api/auth/steward-session`.** CSRF surface — any origin can POST. Add origin allow-list + double-submit token or SameSite=strict cookie. — `cloud-api/src/routes/auth/steward-session/*` — **M** — backend
- [ ] **`redirect_uri` allow-list on Steward side unverified.** Potential open-redirect / token-handoff to attacker-controlled domain. Audit and enforce strict allow-list on Steward. — Steward repo — **M** — backend
- [ ] **Cross-site cookie sync broken under 3rd-party-cookie blocking.** Sync between `elizaos.ai` and `elizacloud.ai` relies on 3rd-party cookies that Safari ITP and Chrome's upcoming default block. Move to a first-party redirect flow with short-lived signed handoff token. — backend + frontend — **L** — backend
- [ ] **`packages/app` has no Steward integration.** Desktop app is disjoint from web SSO; user logs in twice. Wire the same Steward session flow (with desktop-appropriate redirect — loopback or deep-link). — `packages/app/*`, `packages/app-core/*` — **L** — frontend

---

## Performance (build audit — new from this round)

- [ ] **`packages/app` main chunk 7.26 MB.** 9 `INEFFECTIVE_DYNAMIC_IMPORT` rollup warnings point at exact split sites; follow them. — `packages/app/vite.config.ts` + dynamic-import callsites — **M** — frontend
- [ ] **`vendor-three-*.js` 1.53 MB in every entry.** Babylon/Three should be lazy-loaded only on 3D routes. — `packages/app`, `cloud-frontend` — **M** — frontend
- [ ] **`cloud-frontend index-*.js` 2.6 MB.** wagmi + viem in the entry chunk; route-split web3-only pages. — `cloud-frontend/vite.config.ts` — **M** — frontend
- [ ] **Oversized agent/avatar PNGs.** Several files in `cloud-frontend/dist/agents/` and `dist/avatars/` are 2–3.5 MB. Convert to WebP/AVIF, generate `srcset`. — `cloud-frontend/public/agents/*`, `cloud-frontend/public/avatars/*` — **S** — frontend
- [ ] **viem version drift in @wagmi/core.** `IMPORT_IS_UNDEFINED wallet` warning during build. Pin matching viem version. — root `package.json` / `cloud-frontend/package.json` — **S** — frontend
- [ ] **Duplicate cloud video shipped twice.** `cloud-frontend/dist/clouds/clouds_8x_1080p.mp4` AND `dist/brand/background/optimized/clouds_8x_1080p.mp4` — dedup the source paths. — `cloud-frontend/public/*` — **S** — frontend
- [ ] **`bun run build` wrapper returns exit 0 without running vite when piped to non-TTY stdout.** Bun-CLI quirk; breaks CI when build output is redirected. File upstream issue + workaround in the wrapper script. — `scripts/build.mjs` (or equivalent) — **S** — devex

---

## Code quality

- [ ] **3 pre-existing tsc errors blocking clean typecheck.** Unrelated to brand work but block clean `tsc`:
  - `cloud-frontend/src/dashboard/billing/Page.tsx` — `UserProfile.org_id` missing field
  - `cloud-shared/src/lib/events/credit-events-redis.ts` — Redis union type
  - chat-redirect module — type resolution failure
  — **S** each — backend + frontend
- [ ] **Verify `eliza-chat-interface.tsx` xs-rounding pass landed cleanly.** The in-app-chat agent did the pass over 26 `rounded-lg/xl` instances; spot-check the resulting bubbles match the chat-bubble radius spec. — `cloud-frontend/src/components/chat/eliza-chat-interface.tsx` — **S** — frontend

---

## Product gaps (remaining)

- [ ] **Add a character-pick step to `CreateElizaAgentDialog`.** Currently asks for name + flavor only. If "pick a character" is part of the product vision, adding it would give the created agent a `username` and make `/chat/@username` resolve as an alternative to the new agent-id chat route. — `cloud-frontend/src/components/agents/create-eliza-agent-dialog.tsx` — **M** — Shaw (product call) → frontend
- [ ] **Replace `/dashboard/chat` redirect.** It currently `Navigate`s to `/dashboard/my-agents`, which is no longer a chat surface. Either route to a real chat surface (`/dashboard/agents/[id]/chat`?) or remove the dead route. — `cloud-frontend/src/pages/dashboard/chat.tsx` — **S** — frontend
- [ ] **Resolve the `theme-app` onboarding-marketing TODO in `packages/app/src/main.tsx:309`.** When `@elizaos/ui`'s onboarding component gains an explicit "marketing theme" preset, point `APP_BRANDING.onboardingTheme` at it here. Currently a `TODO(brand)` comment. — `packages/app/src/main.tsx:309` — **S** — frontend (blocked on `@elizaos/ui`)

---

## Native binary assets (designer regeneration required)

All from `/brand/logos/logo_white_orangebg.svg` — white Eliza logo, centered, on a solid `#FF5800` field, square unless noted. Full spec with ImageMagick command templates is at `packages/app/DESIGNER-ASSETS.md` (51 PNGs enumerated). The text-level theme config and storyboard backdrops are on brand; only these PNGs (and one foreground drawable) carry stale visual content.

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

## Out-of-scope packages (sibling agents on it / deferred)

- [ ] **Wire `<CloudVideoBackground>` inside `@elizaos/ui` `App.tsx`.** The actual first-rendered React surface ("home screen" before an agent is connected) lives in `packages/ui/src/App.tsx` and the `AppProvider` / `AppWorkspaceChrome` orchestration around it. Sibling agent on it. — `packages/ui/src/App.tsx`, `packages/ui/src/backgrounds/CloudVideoBackground.tsx`, also touches `@elizaos/app-core` — **M** — frontend
- [ ] **Electrobun window background.** Brand the native window chrome. Out of scope of the redesign; lives in `packages/app-core/platforms/electrobun/`. — **S** — frontend
- [ ] **`homepage/src/pages/leaderboard.tsx` (1613 LOC).** Misnamed onboarding flow. Replace its `ShaderBackground` with a flat brand color per step without breaking the state machine. Sibling agent on it. — `apps/homepage/src/pages/leaderboard.tsx` — **L** — frontend

---

## Tooling / external

- [ ] **Mintlify deep customization tracking.** Code-block fill, navbar typography, sidebar typography are currently overridden via `!important` in `style.css` because the Mintlify schema doesn't expose direct toggles. Track upstream — drop the overrides when Mintlify adds first-class support. — `docs/style.css` — **S** (ongoing) — frontend

---

## Done in this redesign

So the next person doesn't redo work:

### Foundation (rounds 1–3)

- `@elizaos/shared-brand` package established — brand tokens, logo SVG (`logo_white_orangebg.svg`), OG embed SVGs, fonts (Poppins).
- Three brand themes wired: `theme-app` (orange marketing), in-product dark, transitional light dashboard.
- `<CloudVideoBackground>` clouds-as-background component built and deployed on the five primary surfaces.
- Five primary surfaces redesigned end-to-end: marketing homepage, cloud-frontend top-level dashboards, checkout page, sensitive-requests page, agent-list dashboard chrome.
- A11y pass completed for the primary surfaces (residual items closed in round 4–7).
- Hardware-preorder homepage tiles rebranded.
- Android `drawable/ic_launcher_background.xml` already encodes `#FF5800` — foregrounds are the only piece left for Android icons.
- `packages/app/BRAND-TODO.md` was the designer-asset source list; this document supersedes it (kept in place for designer convenience).
- `TODO(brand)` source comments tracked: `packages/app/src/main.tsx:309` (onboarding-theme preset, listed above).

### Rounds 4–7

- **In-app chat after agent creation:** `/dashboard/agents/[id]/chat` route added; `my-agents` `AgentConsoleOverview` repainted dark; `eliza-chat-interface.tsx` xs-rounded.
- **Hardware catalog deduplication:** `@elizaos/hardware-catalog` package created; consumed by `os-homepage` + `cloud-frontend` + `cloud-api`.
- **Orphan SKU `elizaos-usb-plastic`:** kept in the new catalog with full copy (subtitle, slug `usb-plastic`, Stripe meta).
- **CheckoutPage consolidation:** `@elizaos/checkout-shared` package extracts the Stripe POST + redirect; both pages keep their own auth shell.
- **Native PNG asset spec:** `packages/app/DESIGNER-ASSETS.md` enumerates 51 PNGs with ImageMagick command templates.
- **A11y polish:** contrast bumps; focus rings; color-swatch `focus-visible`; landing-page `<main id="main">`; ~22 dashboard `text-white/45-50` → `/74` bumps.
- **CSS dedup:** `--brand-*` redeclarations removed from homepage + os-homepage `index.css`; `docs/style.css` got a `:root` block + 6 hex literals tokenized.
- **Cloud video cleanup:** sync script `--clouds` flag (off by default); pruned 51 MB from 3 non-consumer packages; `marketing.tsx` migrated to `<CloudVideoBackground>`.
- **Playwright config polish:** `maxDiffPixelRatio: 0.02` added to homepage + os-homepage; `os-usb-installer` now has `playwright.config.ts` + dep + `test:e2e` script.
- **CTA verb consistency:** "Launch Eliza" (Cloud) / "Download the app" (App) / "Install elizaOS" (OS) enforced.
- **Mintlify docs:** Tip + first paragraph + headings + cards repainted with AIOS framing.
- **Tails `greeter.css`:** 6 `#0B35F1` literals tokenized with a new `:root` block.
