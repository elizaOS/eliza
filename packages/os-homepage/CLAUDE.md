# @elizaos/os-homepage

Marketing and download landing page for elizaOS — a React SPA deployed to Cloudflare Pages.

## Purpose / role

This is the public-facing website for elizaOS hardware and OS downloads. It serves the elizaOS beta download page, hardware product catalog, and the hardware pre-order checkout flow (backed by Eliza Cloud auth and Stripe). It is a standalone private app (`"private": true`) not imported by other packages. It deploys to `https://os.elizacloud.ai`.

## Layout

```
packages/os-homepage/
  src/
    main.tsx                  Entry point — mounts <App> wrapped in <I18nProvider>
    App.tsx                   Router (path-based, no router library) — dispatches to:
                                HomePage (/) — includes ReleaseDownloads as a section at #download
                                CheckoutPage (/checkout)
                                CheckoutResult (/checkout/success, /checkout/cancel)
                                ProductDetail (/hardware/:slug)
    CheckoutPage.tsx          Pre-order checkout; Eliza Cloud (Steward) auth + Stripe
    ProductDetail.tsx         Per-product page from hardware-catalog
    index.css                 Global styles; Tailwind CSS v4 via @tailwindcss/vite
    components/
      OsDownloads.tsx         Reusable download grid; accepts OsArtifact[] prop
    providers/
      I18nProvider.tsx        Minimal i18n context; useT() hook; 8 locales lazy-loaded
    i18n/locales/             JSON translation files: en, zh-CN, ko, es, pt, vi, tl, ja
  public/                     Static assets synced from @elizaos/shared (predev/prebuild hooks)
    _headers                  Cloudflare Pages response headers
    _redirects                Cloudflare Pages SPA fallback rules
    downloads/                elizaos-beta-manifest.json (fetched at runtime for artifact list)
    brand/                    Logos, backgrounds, concept images (gitignored; synced at build)
  tests/                      Playwright e2e + node smoke tests
  scripts/
    capture-screenshots.mjs   Screenshot utility
    regenerate-baselines.sh   Regenerate visual regression baselines
  vite.config.ts              Vite config; custom aliases for @elizaos/shared/* and @elizaos/ui/*
  wrangler.toml               Cloudflare Pages deploy config (project: elizaos-homepage)
  playwright.config.ts        Playwright config for e2e tests
```

## Key imports

The app imports from workspace packages via Vite aliases (not workspace exports — the aliases resolve source files directly):

- `@elizaos/shared/brand` → `../shared/src/brand/index.ts` — `BRAND_PATHS`, `BRAND_COLORS`, `LOGO_FILES`, `EXTERNAL_URLS`
- `@elizaos/shared/hardware-catalog` → `../shared/src/hardware-catalog/index.ts` — `HARDWARE_PRODUCTS`, `Product` type
- `@elizaos/shared/checkout` → `../shared/src/checkout/index.ts` — `startStripeCheckout`, `StripeCheckoutError`
- `@elizaos/shared/steward-session-client` → `../shared/src/steward-session-client/index.ts` — session helpers, constants
- `@elizaos/ui` → `../ui/src/backgrounds/CloudVideoBackground.tsx` — `CloudVideoBackground`
- `@elizaos/ui/i18n/region` → `../ui/src/i18n/region.ts` — `detectClientLanguage`
- `@stwd/sdk` — `StewardAuth` class for magic-link email auth

This package does NOT export anything for other packages to consume.

## Commands

All scripts require Bun. Run from repo root with `--cwd`:

```bash
bun run --cwd packages/os-homepage dev          # Dev server on :4455 (runs predev asset sync first)
bun run --cwd packages/os-homepage build        # Vite build to dist/ (runs prebuild asset sync first)
bun run --cwd packages/os-homepage preview      # Preview built dist/ on :4455
bun run --cwd packages/os-homepage deploy       # wrangler pages deploy to elizaos-homepage project
bun run --cwd packages/os-homepage typecheck    # tsc -b
bun run --cwd packages/os-homepage test         # node --test tests/smoke.node.test.mjs
bun run --cwd packages/os-homepage test:e2e     # Playwright e2e suite
bun run --cwd packages/os-homepage screenshots  # Capture screenshots via scripts/capture-screenshots.mjs
bun run --cwd packages/os-homepage lint         # Biome check + unsafe auto-fix
bun run --cwd packages/os-homepage lint:check   # Biome check only
bun run --cwd packages/os-homepage format       # Biome format --write
```

`predev` and `prebuild` hooks run `packages/shared/scripts/sync-to-public.mjs` to copy logos, OG embeds, concept images, and background videos from `@elizaos/shared` into `public/brand/`. This is required — the directory is gitignored.

## Config / env vars

| Variable | Default | Purpose |
|---|---|---|
| `VITE_ELIZA_CLOUD_API_URL` | `https://api.elizacloud.ai` | Cloud API base for Steward auth + Stripe checkout |

Cloudflare Pages build vars are in `wrangler.toml`:
- `PUBLIC_SITE_URL` = `https://os.elizacloud.ai` (production)
- `PUBLIC_SITE_URL` = `https://os-preview.elizacloud.ai` (preview env)

Language preference is stored in `localStorage` under the key `os.lang`. The `?lang=` query parameter overrides storage on load.

## How to extend

**Add a new download artifact:**
1. Update `public/downloads/elizaos-beta-manifest.json` with the new artifact entry (`id`, `label`, `kind`, `platform`, `architecture`, `url`, `checksumUrl`).
2. The `ReleaseDownloads` component in `src/App.tsx` fetches this manifest at runtime and falls back to the hardcoded `releaseFallback` constant if the fetch fails.
3. For a structured downloads grid (by OS category), use `OsDownloads` from `src/components/OsDownloads.tsx` which accepts an `OsArtifact[]` prop with a richer type.

**Add a new hardware product:**
1. Add an entry to `packages/shared/src/hardware-catalog/index.ts` — this is the single source of truth for products, images, SKUs, colors, and pricing.
2. The homepage automatically picks up new products in `HardwareTiles`, `ProductDetail`, and `CheckoutPage`.

**Add a new page/route:**
1. Add the path-match logic to the `App` function in `src/App.tsx` (plain `window.location.pathname` checks — no router library is used).
2. Lazy-import the new page component with `lazy(() => import(...))` and wrap in `<Suspense fallback={<RouteFallback />}>`.

**Add a translation string:**
1. Call `t("homepage_os.<section>.<key>", { defaultValue: "English text" })` — English is inlined; no en.json updates needed.
2. Add the key + translated value to each locale file under `src/i18n/locales/`.
3. Supported locales: `en`, `zh-CN`, `ko`, `es`, `pt`, `vi`, `tl`, `ja`.

## Conventions / gotchas

- **No router library.** Routing is plain `window.location.pathname` checks in `App.tsx`. Keep routes simple; add a redirect in `public/_redirects` for Cloudflare Pages if a new route needs SPA fallback.
- **Asset sync is required before dev/build.** The `predev`/`prebuild` hooks run automatically with `bun run dev` or `bun run build`, but not with raw `vite` commands. If `public/brand/` is empty, run `node packages/shared/scripts/sync-to-public.mjs packages/os-homepage/public --logos --ogembeds --concepts --background --background-videos` manually.
- **Vite aliases resolve workspace source directly** rather than workspace package exports. Adding a new `@elizaos/shared/*` sub-path import requires a corresponding alias entry in `vite.config.ts`.
- **`@elizaos/ui` alias only exposes `CloudVideoBackground`.** The alias `@elizaos/ui` points to one specific file. Other UI components use fully-qualified sub-path aliases (`@elizaos/ui/button`, etc.).
- **`public/_redirects` handles SPA routing.** The Vite build also copies `index.html` to `404.html` via the `spa404Fallback` plugin for Cloudflare Pages compatibility.
- **Build prunes heavy assets.** The `pruneStaticAssets` Vite plugin removes low-resolution cloud textures and redundant concept images from `dist/` after build to reduce deploy size.
- **Checkout uses Steward (Eliza Cloud auth).** The `CheckoutPage` authenticates via OAuth (Google/GitHub/Discord) or magic-link email through the `@stwd/sdk` `StewardAuth` class and then initiates a Stripe session via `startStripeCheckout` from `@elizaos/shared/checkout`. The Stripe session is created server-side by the Eliza Cloud API.
- **The blue accent (`--brand-blue`) is intentional for this surface.** The OS homepage uses blue as its primary accent (distinct from the main app's orange). Do not replace blue with orange here.
