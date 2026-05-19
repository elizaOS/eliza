# BRAND-TODO

Canonical follow-up list for the multi-round Eliza brand redesign. Consolidates every deferred item from prior agents (designer asset lists, in-code `TODO(brand)` comments, accessibility audit, product-flow walk, hardware-preorder review, checkpoint commits, and rounds 4–10 follow-ups).

## Where the redesign stands

Ten rounds in. Five primary surfaces have been redesigned end-to-end against the Eliza brand (white logo on `#FF5800`, Poppins, sharp corners on marketing / xs-rounding inside chat, dark in-product chrome). Three brand themes are wired (`theme-app` orange marketing, dark in-product, light dashboard transitional). The `<CloudVideoBackground>` clouds-as-background treatment is live on the primary surfaces, and a `@elizaos/shared-brand` package centralises tokens, OG embed SVGs, and the logo. Rounds 4–7 closed the in-app chat loop, deduplicated the hardware catalog, extracted `@elizaos/checkout-shared`, finished the a11y polish, and tokenized CSS literals. Round 8 hardened the SSO handoff (server-side nonce exchange + per-consumer brand sync flags). Round 9 finished the cookie-based refresh-token migration, completed the PNG→WebP rollout, brand-passed `leaderboard.tsx`, deduped the Playwright install, and produced an actionable bundle visualizer report. **Round 10** landed the first four bundle perf wins (main chunk 1.36 MB → 928 KB gzip, -32%), fixed the `RuntimeGate` `borderRadius: 0` regression, cleaned all 13 biome lint errors, tokenized hex literals across the highest-impact dashboard files (373 → 177 remaining), filed the Steward cleanup PR, and restored the `ensureLanguageLoaded` re-export. What remains is a smaller residual set: the final JS-context hex migration, the apps-registry route-split, native PNG regen, plus the long-known designer-asset and out-of-scope surfaces.

---

## Security (SSO / auth)

- [ ] **Refresh tokens passed via URL query.** `elizaos.ai/checkout?token=...&refreshToken=...` leaks tokens to referer headers, browser history, and any in-page analytics. Move to `#fragment` minimum, or do a server-side nonce exchange. — `cloud-frontend` checkout entry + Steward redirect — **M** — backend + frontend
- [ ] **No origin/referer check on `POST /api/auth/steward-session`.** CSRF surface — any origin can POST. Add origin allow-list + double-submit token or SameSite=strict cookie. — `cloud-api/src/routes/auth/steward-session/*` — **M** — backend
- [ ] **`redirect_uri` allow-list on Steward side unverified.** Potential open-redirect / token-handoff to attacker-controlled domain. Audit and enforce strict allow-list on Steward. — Steward repo — **M** — backend
- [ ] **Cross-site cookie sync broken under 3rd-party-cookie blocking.** Sync between `elizaos.ai` and `elizacloud.ai` relies on 3rd-party cookies that Safari ITP and Chrome's upcoming default block. Move to a first-party redirect flow with short-lived signed handoff token. — backend + frontend — **L** — backend (structural)
- [ ] **`packages/app` has no Steward integration.** Desktop app is disjoint from web SSO; user logs in twice. Wire the same Steward session flow (with desktop-appropriate redirect — loopback or deep-link). — `packages/app/*`, `packages/app-core/*` — **L** — frontend

---

## Performance (build / bundle)

- [ ] **Bundle perf win #5 — `apps/` subtree route-split via React.lazy.** Wins #1–4 (zod dedup, i18n lazy with 6 locale chunks, onboarding-presets, cron-parser) landed in round 10 — main chunk 1.36 MB → 928 KB gzip (-32%). The apps-registry refactor is the remaining recommendation. — `packages/app/vite.config.ts` + apps registry callsites — **M** — frontend
- [ ] **`packages/app` main chunk remaining `INEFFECTIVE_DYNAMIC_IMPORT` warnings.** Down from 9; finish following the rollup warnings to their exact split sites. — `packages/app/vite.config.ts` + dynamic-import callsites — **S** — frontend
- [ ] **`vendor-three-*.js` 1.53 MB in every entry.** Babylon/Three should be lazy-loaded only on 3D routes. — `packages/app`, `cloud-frontend` — **M** — frontend
- [ ] **`cloud-frontend index-*.js` 2.6 MB.** wagmi + viem in the entry chunk; route-split web3-only pages. — `cloud-frontend/vite.config.ts` — **M** — frontend
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
- [ ] **2 biome variable-shadow warnings (unsafe-suggested).** Round 10 cleared all 13 lint errors; 2 unsafe-suggested shadow warnings remain pending manual review. — **S** — frontend
- [ ] **~177 hex literals in JS context.** Round 10 tokenized className literals in the 4 highest-impact files plus the top 20 dashboard files (373 → 177). The remainder are inline `style={{ color: '#...' }}` and similar JS-context literals. Sibling agent may be in flight. — `cloud-frontend/src/**`, `packages/ui/src/**` — **M** — frontend
- [ ] **Open Sans remnants.** Despite earlier reports of full removal, ~38 references remain in source — notably `packages/homepage/src/components/ChatUI/renderChatToCanvas.ts` (canvas `ctx.font` strings), `packages/ui/src/companion/CompanionShell.tsx`, `packages/ui/src/components/onboarding/BootstrapStep.tsx`, `packages/ui/src/components/pages/VectorBrowserView.tsx`, `packages/browser-bridge-extension/public/popup.css`, `plugins/plugin-screenshare/src/routes.ts`, `packages/ui/src/components/onboarding/states/onboarding.css`. Replace with Poppins (canvas) / brand stack. — **S** — frontend
- [ ] **Test fixture drift.** Cloud-frontend mock fixtures + ui onboarding label fixtures out of sync with current copy (2 vitest failures in cloud-frontend, 10 in ui onboarding). — `cloud-frontend/src/**/__tests__/*`, `packages/ui/src/onboarding/**/*.test.tsx` — **S** — frontend
- [ ] **Verify `eliza-chat-interface.tsx` xs-rounding pass landed cleanly.** Spot-check the resulting bubbles match the chat-bubble radius spec. — `cloud-frontend/src/components/chat/eliza-chat-interface.tsx` — **S** — frontend

---

## Product gaps

- [ ] **Add a character-pick step to `CreateElizaAgentDialog`.** Currently asks for name + flavor only. If "pick a character" is part of the product vision, adding it would give the created agent a `username` and make `/chat/@username` resolve as an alternative to the new agent-id chat route. — `cloud-frontend/src/components/agents/create-eliza-agent-dialog.tsx` — **M** — Shaw (product call) → frontend
- [ ] **Replace `/dashboard/chat` redirect.** It currently `Navigate`s to `/dashboard/my-agents`, which is no longer a chat surface. Either route to a real chat surface (`/dashboard/agents/[id]/chat`?) or remove the dead route. — `cloud-frontend/src/pages/dashboard/chat.tsx` — **S** — frontend
- [ ] **Resolve the `theme-app` onboarding-marketing TODO in `packages/app/src/main.tsx:309`.** When `@elizaos/ui`'s onboarding component gains an explicit "marketing theme" preset, point `APP_BRANDING.onboardingTheme` at it here. Currently a `TODO(brand)` comment. — `packages/app/src/main.tsx:309` — **S** — frontend (blocked on `@elizaos/ui`)

---

## Native binary assets (designer regeneration required)

All from `/brand/logos/logo_white_orangebg.svg` — white Eliza logo, centered, on a solid `#FF5800` field, square unless noted. Full spec with ImageMagick command templates is at `packages/app/DESIGNER-ASSETS.md` (51 PNGs enumerated). The text-level theme config and storyboard backdrops are on brand; only these PNGs (and one foreground drawable) carry stale visual content.

- [ ] **Native PNG regeneration (~51 files).** Sibling agent in flight; covers all iOS/Android/web PNGs listed below in one pass. — **L** — designer / scriptable export
- [ ] **iOS Splash imageset (3 PNGs).** `packages/app/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png`, `…-1.png`, `…-2.png`. — **S** — designer
- [ ] **iOS AppIcon imageset (~18 PNGs).** `packages/app/ios/App/App/Assets.xcassets/AppIcon.appiconset/*`. `AppIcon-ios-marketing-1024.png` is the master; the rest scale down. — **M** — designer
- [ ] **iOS public web icons.** `apple-touch-icon.png`, `android-chrome-192x192.png`, `android-chrome-512x512.png`, `favicon-16x16.png`, `favicon.ico`, `og-image.png` (1200×630) under `packages/app/ios/App/App/public/`. — **S** — designer
- [ ] **Android splash PNGs (~11 files).** All densities, portrait + landscape, under `packages/app/android/app/src/main/res/drawable*`. — **M** — designer
- [ ] **Android adaptive launcher foregrounds + legacy icons (~5 densities).** `mipmap-*/ic_launcher_foreground.png`, `mipmap-*/ic_launcher.png`, `mipmap-*/ic_launcher_round.png`. `drawable/ic_launcher_background.xml` already encodes `#FF5800`; foregrounds need a white Eliza glyph that fits the adaptive-icon safe-area (66dp of 108dp). — **M** — designer
- [ ] **Root `packages/app/public/og-image.png` — 1200×630 white logo on orange.** — **S** — designer
- [ ] **Per-site OG PNGs.** Currently SVG only in `shared-brand` OG embeds. Twitter/X accepts SVG; LinkedIn and Facebook prefer PNG. Generate 1200×630 PNGs from each site's OG embed SVG. — `packages/shared-brand/og/*` — **S** — designer or scriptable export

---

## Out-of-scope packages (sibling agents on it / deferred)

- [ ] **Wire `<CloudVideoBackground>` inside `@elizaos/ui` `App.tsx`.** The actual first-rendered React surface ("home screen" before an agent is connected) lives in `packages/ui/src/App.tsx` and the `AppProvider` / `AppWorkspaceChrome` orchestration around it. Sibling agent on it. — `packages/ui/src/App.tsx`, `packages/ui/src/backgrounds/CloudVideoBackground.tsx`, also touches `@elizaos/app-core` — **M** — frontend
- [ ] **Electrobun window background.** Brand the native window chrome. Out of scope of the redesign; lives in `packages/app-core/platforms/electrobun/`. — **S** — frontend

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
- A11y pass completed for the primary surfaces (residual items closed in rounds 4–7).
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

### Round 8

- **Refresh tokens migrated off localStorage.** No login path writes refresh tokens to localStorage anymore (`os-homepage` + `cloud-frontend`). HttpOnly `steward-refresh-token` cookie set by `/api/auth/steward-session` and `/api/auth/steward-nonce-exchange` is the only persistence.
- **`POST /api/auth/steward-refresh` route.** Reads the HttpOnly cookie server-side and mints new HttpOnly cookies; no token ever appears in the response body.
- **Deprecation shim:** `read/writeStoredStewardRefreshToken()` helpers marked `@deprecated` with a console warning; `writeStoredStewardRefreshToken()` is a no-op; localStorage key constant retained one release for legacy-tab cleanup.

### Round 9 final follow-ups

- **cloud-frontend Steward nonce-exchange mirror** — 4 files updated; `index.html` got pre-init script + referrer meta; tsc clean.
- **Steward cleanup PR filed** — https://github.com/Steward-Fi/keep/pull/46 (DO NOT MERGE prefix; blocked on #45 + 1-release window).
- **PNG → WebP rollout** — 15 files, 22.41 MB / 90.8% reclaimed; per-consumer shared-brand sync flags reclaimed ~142 MB across consumers.
- **`leaderboard.tsx` brand pass** — `ShaderBackground` opt-in via `?shader=1`; flat brand-color per platform.
- **bun install + Playwright dedup verified** — single canonical version. Vitest verified: only 2 pre-existing failures in cloud-frontend + 10 in ui onboarding remain (both tracked as fixture-drift open item).
- **Bundle visualizer dive** — `packages/app/dist/stats.html` produced with top-5 actionable recommendations (tracked as bundle perf rollout open item).

### Round 10 final cleanup

- **Open Sans removed from CSS @imports + package.json deps** — 2 CSS @imports and 6 package.json font dependencies cleared. (Note: ~38 source-level usages remain in canvas-rendered fonts and a handful of components — carried forward as a smaller follow-up; see open item.)
- **`RuntimeGate` `borderRadius: 0` regression fixed** — 9 sites repointed to `var(--radius-xs, 3px)`.
- **Biome lint cleaned** — 13 errors → 0 errors; 11 files auto-fixed. 2 unsafe-suggested variable-shadow warnings remain (carried as open item).
- **Hex tokenization** — workspace literals 373 → 177. `className` literals fully tokenized in the 4 highest-impact files plus the top 20 dashboard files. Remaining 177 are JS-context inline-style literals.
- **Bundle perf wins #1–4 landed** — zod dedup, i18n lazy with 6 locale chunks split, onboarding-presets already split upstream, cron-parser already mitigated. Main chunk: 1.36 MB → 928 KB gzip (-32%).
- **`ensureLanguageLoaded` re-export fix** in `packages/ui/src/i18n/index.ts`.
- **Steward cleanup PR #46 ready** — https://github.com/Steward-Fi/keep/pull/46 (DO NOT MERGE prefix; blocked on #45 + 1-release window).
