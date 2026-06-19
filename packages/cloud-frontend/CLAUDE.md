# @elizaos/cloud-frontend

The Eliza Cloud web dashboard + public marketing/auth surface. React 19 SPA built with Vite, Tailwind v4, React Router v7. Talks to the Cloud API over same-origin `/api/*`; auth runs through the Steward (`@stwd`) SDK. This is an **application**, not a library — it has no `main`/`module`/`exports` and nothing imports from it. It consumes `@elizaos/cloud-shared` (DTOs, steward URL helpers), `@elizaos/shared` (brand, steward-session client), and `@elizaos/ui` (cloud UI bundle, i18n).

Repo-wide rules (logger-only, ESM, naming, architecture commandments) live in the root AGENTS.md — not repeated here. **Any UI change in this package must run the visual-review protocol** before "done": `bun run --cwd packages/cloud-frontend audit:cloud`, then fill `aesthetic-audit-output/manual-review/<slug>.md` per page. Full protocol: `docs/HOVER_SYSTEM.md`, `docs/E2E_COVERAGE_GAPS.md`, `docs/DASHBOARD_REDESIGN.md`.

## Layout

```
src/
  main.tsx               Client entry. Buffer polyfill, providers, hydrate-or-render.
  entry-server.tsx       SSR entry — renders the landing route to a static string (build-time only).
  App.tsx                ALL routes (react-router <Routes>). lazyWithPreload + PRELOAD_ROUTES warming.
  RootLayout.tsx         Wraps every route: Helmet meta, wallet/Steward/Credits/Theme providers, Toaster.
  globals.css            Tailwind v4 entry + theme tokens (single CSS file).
  pages/                 Public + auth + payment routes (file-route-style dirs, e.g. pages/payment/[paymentRequestId]/page.tsx).
  dashboard/             Authenticated dashboard. DashboardLayout.tsx + one dir per pane
                         (apps, agents, billing, analytics, api-keys, mcps, earnings, admin, ...).
                         _components/ = dashboard-only shared UI.
  components/            Cross-route shared UI (landing, layout, chat, agents, onboarding, security).
  providers/             React context providers:
                           StewardProvider.tsx        Steward auth session, syncs JWT to api client.
                           StewardProviderRuntime.tsx Runtime variant of the Steward provider.
                           ConditionalWalletProviders  wagmi/rainbowkit + solana wallet adapters.
                           CreditsProvider.tsx         polls /api/credits/balance, useCredits().
                           I18nProvider.tsx            language resolution + useT/useI18n.
  hooks/                 use-session-auth, use-job-poller, use-admin, use-streaming-message, ...
  lib/
    api-client.ts        Typed fetch wrapper `api<T>(path, init)`; injects Steward token; throws ApiError.
    api-fetch-bridge.ts  installApiFetchBridge() — rewrites cross-origin /api calls to the right upstream.
    query-client.ts      shared @tanstack/react-query QueryClient.
    data/                React Query hooks per domain (apps.ts, agents.ts, billing via credits.ts, analytics.ts, ...).
    steward-session.ts   Steward token storage glue.
    security/            audit-client, consent-store.
  runtime/               Render-telemetry utilities (currently a test-only file).
  types/                 ambient *.d.ts for untyped deps (canvas-confetti, web3icons, ...).
  shims/                 browser polyfills aliased in vite.config (process, inherits, wagmi-tempo).
functions/               Cloudflare Pages Functions: _middleware.ts, _proxy.ts (proxies /api to the Cloud API worker).
scripts/
  prerender.mjs          Splices entry-server output into dist/index.html (FCP/LCP win).
  run-e2e.mjs            Playwright runner (boots the vite dev server, injected-ethereum login).
  generate-assistant-concept-images.ts
vite.config.ts           Build + dev config: @/ alias map, shims, rolldown code-splitting groups, env defines.
playwright.config.ts     E2E projects: chromium-desktop / mobile.
wrangler.toml            Cloudflare Pages: name=eliza-cloud, API_UPSTREAM per env.
```

## Routing

`src/App.tsx` is the single source of truth for every route. `RootLayout` is the parent of all routes; `/dashboard` mounts `DashboardLayout` (auth-gated via `DashboardRouteElement`). Pages are `lazyWithPreload()`-wrapped; nav can call `.preload()` on hover. Removed/renamed routes use `<Navigate>`/`DashboardRedirect`. The aesthetic-audit walks every route declared here.

## DTOs / shared types

Domain DTOs come from `@elizaos/cloud-shared` (path alias `@/lib/types/cloud-api` → `../cloud-shared/src/lib/types/cloud-api`). Do not redefine API shapes locally — import the DTO and narrow with `Omit`/`Pick` when a field is legacy (see `lib/data/apps.ts` `App` type). `@/components/*` resolves to either local `src/components` or `../ui/src/cloud-ui/components`; `@elizaos/ui` is `../ui/src/cloud-ui/index.ts`.

## Commands

```bash
bun run --cwd packages/cloud-frontend dev            # vite dev server
bun run --cwd packages/cloud-frontend build          # client build + SSR build + prerender
bun run --cwd packages/cloud-frontend build:client   # client bundle only
bun run --cwd packages/cloud-frontend preview         # serve dist on :3000
bun run --cwd packages/cloud-frontend typecheck      # tsgo --noEmit
bun run --cwd packages/cloud-frontend test           # vitest run
bun run --cwd packages/cloud-frontend test:e2e       # Playwright (scripts/run-e2e.mjs)
bun run --cwd packages/cloud-frontend test:e2e:live-auth
bun run --cwd packages/cloud-frontend audit:cloud    # aesthetic audit (REQUIRED for UI changes)
bun run --cwd packages/cloud-frontend lint           # biome check
bun run --cwd packages/cloud-frontend lint:fix
bun run --cwd packages/cloud-frontend verify         # lint + typecheck + build
```

`predev`/`prebuild` run `../shared/scripts/sync-to-public.mjs` to sync brand logos/og-embeds/background assets into `public/`.

## Config / env vars

All custom env vars must be read by their **literal name** — Vite inlines `import.meta.env.VITE_FOO` only when accessed literally; dynamic `env[name]` returns `undefined` in prod builds (see the note in `StewardProvider.tsx`).

- `VITE_API_URL` / `NEXT_PUBLIC_API_URL` — API base for SSR/scripts; browser always uses same-origin.
- `VITE_APP_URL` / `NEXT_PUBLIC_APP_URL` — canonical site origin for OG/canonical tags.
- `NEXT_PUBLIC_STEWARD_TENANT_ID` — Steward tenant override (default: `"elizacloud"`).
- `VITE_PLAYWRIGHT_TEST_AUTH` / `NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH` — enables the synthetic-JWT auth bypass for e2e.
- `VITE_ELIZA_CLOUD_LOCAL_DEV_ADMIN` — exposes admin pages to any authenticated user in local dev (prod keeps the role gate).
- `VITE_ELIZA_RENDER_TELEMETRY` — enables render telemetry (read in `main.tsx`).
- Wallet/RPC: `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`, `NEXT_PUBLIC_ALCHEMY_API_KEY`, `NEXT_PUBLIC_HELIUS_API_KEY`, `NEXT_PUBLIC_SOLANA_RPC_URL`, `NEXT_PUBLIC_DEVNET`.
- `functions/_proxy.ts` reads Cloudflare `API_UPSTREAM` (set in `wrangler.toml`) to forward `/api/*` to the Cloud API worker.

## How to extend

- **Add a route:** create `src/pages/<name>/page.tsx` (or a `dashboard/<pane>/` dir), declare a `lazyWithPreload` const + `<Route>` in `src/App.tsx`. Dashboard panes nest under the `/dashboard` route. New routes auto-stub a `manual-review/<slug>.md` on the next `audit:cloud`.
- **Add a data hook:** add a file under `src/lib/data/` exporting a `useX()` React Query hook that calls `api<T>("/api/...")` and gates on auth via `useAuthenticatedQueryGate` + `authenticatedQueryKey`. Import the response DTO from `@elizaos/cloud-shared`, never hand-roll it.
- **Call the API outside a component:** import `api` / `ApiError` from `src/lib/api-client.ts`. Browser calls must be same-origin paths (`/api/...`); cross-origin URLs throw `CROSS_ORIGIN_API_URL`.
- **Add a shared component:** prefer the cloud UI bundle in `@elizaos/ui` (`../ui/src/cloud-ui`); only put it in local `src/components/` if it is cloud-frontend-specific.

## Conventions / gotchas

- **No `main`/`exports`** — nothing imports this package. Don't add a barrel.
- **Same-origin API only in the browser.** `api-client.ts` rejects cross-origin `/api` URLs so the Steward cookie/token stays scoped.
- **SSR is build-time prerender only**, scoped to the landing route. `entry-server.tsx` deliberately omits Steward/Credits/wallet providers (client-only); keep the SSR tree matching what an anonymous landing visitor renders or hydration mismatches blank the page. Note `main.tsx` currently force-disables prerender hydration (`shouldHydratePrerenderedMarkup = false`) and does a clean client render.
- **Env vars: read literally** (see Config). Dynamic lookups silently break in prod.
- **Buffer polyfill must load first** in both `main.tsx` and `entry-server.tsx` (Solana/viem read `globalThis.Buffer` at module init).
- **Palette rules** are enforced by the aesthetic audit: brand orange is accent only, no blue anywhere, orange↔black hover transitions banned, border-radius limited to {0, 3px, pill}. Fix violations in `globals.css` / component source, never silence the audit.
