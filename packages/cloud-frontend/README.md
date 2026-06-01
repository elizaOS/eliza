# `@elizaos/cloud-frontend`

The Eliza Cloud web dashboard and public marketing/auth surface. A React 19 single-page app built with Vite, Tailwind v4, and React Router v7. It talks to the Cloud API over same-origin `/api/*` and authenticates through the Steward (`@stwd`) SDK.

## What it provides

- Public landing, terms/privacy, and public agent chat.
- Sign-in, OAuth/email callbacks, CLI login, and app-authorize flows.
- Dashboard panes (auth-gated under `/dashboard`):
  - **Apps** — register an `appId`, edit redirects, version + publish.
  - **Agents / My Agents** — manage and chat with Eliza agents.
  - **Billing & Credits** — top-up, invoices, Stripe portal.
  - **Earnings & Affiliates** — creator monetization.
  - **Analytics** — usage and cost breakdown.
  - **API Keys, MCPs, Documents, API Explorer**.
  - **Admin** — infrastructure, metrics, redemptions, RPC status.
- Payment, approval, ballot, and sensitive-request flows.

## Layout

```
src/
  App.tsx          All routes (react-router).
  RootLayout.tsx   Global providers + Helmet metadata + Toaster.
  pages/           Public + auth + payment routes.
  dashboard/       Authenticated dashboard panes.
  components/      Cross-route shared UI.
  providers/       Steward auth, wallet, credits, i18n contexts.
  hooks/           Session, polling, streaming, admin hooks.
  lib/             api-client, react-query hooks (lib/data), security.
functions/         Cloudflare Pages Functions (edge proxy to the Cloud API).
scripts/           prerender, e2e runner, asset generation.
```

DTOs are imported from `@elizaos/cloud-shared`; shared UI from `@elizaos/ui`; brand and Steward-session helpers from `@elizaos/shared`.

## Local dev

```bash
bun install
bun run --cwd packages/cloud-frontend dev      # vite dev server on http://localhost:3000
```

The browser always calls the API same-origin (`/api/*`). For SSR/scripts the base resolves from `VITE_API_URL` / `NEXT_PUBLIC_API_URL`. Steward auth defaults to the same-origin `/steward` mount; override with `NEXT_PUBLIC_STEWARD_API_URL`.

## Build

```bash
bun run --cwd packages/cloud-frontend build    # client build + SSR landing build + prerender
bun run --cwd packages/cloud-frontend preview  # serve dist on :3000
```

`build` produces a static `dist/` (Cloudflare Pages output) with the landing route prerendered into `index.html` for fast first paint.

## Visual review (required for UI changes)

Any change to UI in this package must pass the aesthetic-audit loop before it is considered done:

```bash
bun run --cwd packages/cloud-frontend audit:cloud
```

This walks every route at desktop + mobile viewports, captures screenshots, and writes per-page review stubs under `aesthetic-audit-output/`. See `docs/HOVER_SYSTEM.md` and `AGENTS.md` for the full protocol and palette rules.

## User-facing docs

The dashboard's user flows are documented under the [Cloud track](../docs/tracks/cloud/overview.mdx) in the docs site.
