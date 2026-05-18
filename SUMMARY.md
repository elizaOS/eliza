# Eliza brand redesign — SUMMARY

A ten-round multi-agent pass against the Eliza brand. Source of truth for follow-ups is `BRAND-TODO.md`; this document is the narrative.

## Brand at a glance

- White Eliza logo on `#FF5800` orange field — `brand/logos/logo_white_orangebg.svg`.
- Poppins, with sharp corners on marketing surfaces and xs-rounding inside chat.
- Dark in-product chrome; transitional light dashboard.
- Three themes wired in `@elizaos/shared-brand`: `theme-app` (orange marketing), in-product dark, light dashboard.
- `<CloudVideoBackground>` clouds-as-background component is the canonical hero treatment on primary surfaces.

## Primary surfaces (all redesigned end-to-end)

1. Marketing homepage (`apps/homepage`).
2. Cloud-frontend top-level dashboards.
3. Checkout page (`cloud-frontend` + `os-homepage`, sharing `@elizaos/checkout-shared`).
4. Sensitive-requests page.
5. Agent-list dashboard chrome.

## Round timeline

### Rounds 1–3 — Foundation

- `@elizaos/shared-brand` package established (tokens, logo SVG, OG embed SVGs, Poppins).
- Three themes wired.
- `<CloudVideoBackground>` built and deployed across the five primary surfaces.
- Initial a11y pass for primary surfaces.
- Hardware-preorder tiles rebranded.
- Android `ic_launcher_background.xml` color set to `#FF5800` (foregrounds left for designer).

### Rounds 4–7 — In-app chat, dedup, polish

- **In-app chat after agent creation:** `/dashboard/agents/[id]/chat` route added; `my-agents` repainted dark; `eliza-chat-interface.tsx` xs-rounded (26 instances).
- **Hardware catalog dedup:** `@elizaos/hardware-catalog` package; consumed by `os-homepage`, `cloud-frontend`, `cloud-api`. Orphan SKU `elizaos-usb-plastic` preserved.
- **Checkout consolidation:** `@elizaos/checkout-shared` extracts Stripe POST + redirect; both pages retain their own auth shell.
- **Native PNG spec:** `packages/app/DESIGNER-ASSETS.md` enumerates 51 PNGs with ImageMagick templates.
- **A11y polish:** contrast bumps, focus rings, color-swatch `focus-visible`, `<main id="main">`, ~22 `text-white/45-50` → `/74` bumps.
- **CSS dedup:** `--brand-*` redeclarations removed from homepage + os-homepage; `docs/style.css` got a `:root` block + 6 hex literals tokenized.
- **Cloud video cleanup:** sync script `--clouds` flag (off by default); pruned 51 MB from 3 non-consumer packages.
- **Playwright config polish:** `maxDiffPixelRatio: 0.02`; `os-usb-installer` got its own config.
- **CTA verb consistency:** "Launch Eliza" (Cloud) / "Download the app" (App) / "Install elizaOS" (OS).
- **Mintlify docs:** Tip + first paragraph + headings + cards repainted with AIOS framing.
- **Tails `greeter.css`:** 6 `#0B35F1` literals tokenized.

### Round 8 — Auth hardening

- Refresh tokens migrated off localStorage on every login path (`os-homepage` + `cloud-frontend`).
- HttpOnly `steward-refresh-token` cookie set by `/api/auth/steward-session` and `/api/auth/steward-nonce-exchange` is the sole persistence.
- New `POST /api/auth/steward-refresh` route rotates sessions server-side via the cookie; no token in the response body.
- Legacy helpers (`read/writeStoredStewardRefreshToken`) marked `@deprecated`; write is now a no-op; localStorage key constant retained one release for legacy-tab cleanup via `clearStoredStewardToken()`.

### Round 9 final follow-ups

- **cloud-frontend Steward nonce-exchange mirror** — 4 files updated; `index.html` got pre-init script + referrer meta; tsc clean.
- **Steward cleanup PR filed** — https://github.com/Steward-Fi/keep/pull/46 (DO NOT MERGE prefix; blocked on Steward #45 plus a 1-release window).
- **PNG → WebP rollout** — 15 files, 22.41 MB / 90.8% reclaimed; per-consumer `shared-brand` sync flags reclaimed ~142 MB across consumers.
- **`leaderboard.tsx` brand pass** — `ShaderBackground` is now opt-in via `?shader=1`; flat brand-color per platform.
- **Tooling verification** — bun install + Playwright dedup confirmed single canonical version; vitest run isolated 2 pre-existing cloud-frontend failures + 10 ui onboarding failures as fixture drift.
- **Bundle visualizer dive** — `packages/app/dist/stats.html` produced; top-5 recommendations (zod dedup, i18n lazy, luxon trim, apps subtree route-split, onboarding-presets lazy) tracked as the bundle perf rollout item.

### Round 10 final cleanup

- **Bundle perf wins #1–4 landed** — zod dedup, i18n lazy-load with 6 locale chunks split, onboarding-presets already split upstream, cron-parser already mitigated. **Main chunk: 1.36 MB → 928 KB gzip (-32%).**
- **`RuntimeGate` `borderRadius: 0` regression fixed** — 9 sites repointed to `var(--radius-xs, 3px)` so chat bubbles regain their xs-rounding.
- **Biome lint cleaned** — 13 errors → 0; 11 files auto-fixed. 2 unsafe-suggested variable-shadow warnings deferred.
- **Hex tokenization sweep** — workspace literals 373 → 177. `className` literals tokenized in the 4 highest-impact files plus the top 20 dashboard files. Remaining 177 are JS-context inline-style literals carried as an open item.
- **Open Sans cleanup (partial)** — 2 CSS `@import` lines and 6 package.json font dependencies removed. ~38 source-level usages remain in canvas-rendered fonts (`renderChatToCanvas.ts` etc.) and a handful of components; carried forward as a smaller follow-up.
- **`ensureLanguageLoaded` re-export fix** in `packages/ui/src/i18n/index.ts` (unblocks lazy locale loading).
- **Steward cleanup PR #46 ready** — https://github.com/Steward-Fi/keep/pull/46 (DO NOT MERGE prefix; blocked on Steward #45 plus a 1-release window).

## What's intentionally left

The residual set is small and well-scoped:

- **Bundle perf win #5** — `apps/` subtree route-split via React.lazy (the last of the round-9 visualizer recommendations).
- **JS-context hex literal migration** — ~177 inline-style literals remain after the round-10 className sweep.
- **Open Sans source-level cleanup** — ~38 usages remain after the round-10 CSS/package pass.
- **Native PNG regeneration** (~51 files; sibling in flight) — designer pass per `packages/app/DESIGNER-ASSETS.md`.
- **Test fixture drift** (sibling in flight) — cloud-frontend mocks + ui onboarding labels.
- **SSO security follow-ups** — URL-query token leak, missing CSRF check on `/api/auth/steward-session`, Steward `redirect_uri` audit, 3rd-party-cookie sync (structural), desktop Steward integration.
- **3 pre-existing tsc errors** blocking clean typecheck (unrelated to brand work).
- **2 biome variable-shadow warnings** (unsafe-suggested) pending manual review.
- **Product gaps:** character-pick step in `CreateElizaAgentDialog`; replace `/dashboard/chat` redirect; resolve the `theme-app` onboarding-marketing TODO in `packages/app/src/main.tsx:309` (blocked on `@elizaos/ui`).
- **Out-of-scope packages:** `<CloudVideoBackground>` inside `@elizaos/ui` `App.tsx`; Electrobun window chrome.
- **Mintlify deep customization** — `!important` overrides in `docs/style.css` tracked against upstream.

## BRAND-TODO snapshot

- **Open:** 22
- **Done:** rounds 1–3 foundation block, rounds 4–7 polish block, round 8 auth hardening, round 9 final follow-ups (6 items), round 10 final cleanup (7 items).

See `BRAND-TODO.md` for the live list with file paths, sizing, and owners.
