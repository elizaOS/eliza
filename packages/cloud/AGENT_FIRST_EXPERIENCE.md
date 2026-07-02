# Agent-First Eliza Cloud Experience Plan

Issue: #11340
Date: 2026-07-02

This plan defines the minimal Eliza Cloud experience from the user's point of
view. The product rule is simple: the local Eliza agent stays primary; Cloud is
the hosted control plane for durable identity, billing, app records, public
auth, hosting, domains, analytics, monetization, and managed backend execution.

## Product Contract

- Chat is the first surface. A user should ask Eliza to build, manage, deploy,
  monetize, or promote an app before they are sent to a Cloud console.
- Cloud surfaces appear only when they represent hosted state the local app
  cannot own: account connection, credits, app records, app auth, managed
  frontend deployments, backend containers, domains, analytics, money, and
  public token-gated flows.
- Do not create a second Cloud launcher, a parallel local clone of Cloud app
  management, or standalone tiles for every hosted capability. Fold hosted app
  work into the Applications surface and its app detail tabs.
- The local installed Apps view (`apps`) and Cloud Applications (`cloud-apps`,
  `/dashboard/apps`) are different products and must stay separate.

## Minimal Setup Flow

### 1. First Open: Local Agent Home

The first screen is the local app shell: chat, launcher, local settings, and
local model/device/plugin surfaces. The user can run Eliza without Cloud.

Cloud-only launcher entries stay hidden while the user is disconnected. Today
`cloud-apps` is the only curated Cloud launcher id, and
`curateLauncherPages(..., { cloudActive: false })` drops it.

### 2. Connect Cloud From Account Or Model Setup

When the user chooses a Cloud-backed model, account, billing, connector, or
Cloud Dashboard action, the app asks them to connect Eliza Cloud. The current
Cloud Dashboard owns the connected/disconnected state, billing summary,
checkout/top-up affordances, auto top-up settings, and disconnect path.

On the hosted web apex, unauthenticated control-plane visitors are routed to
Steward login instead of the local agent catch-all. Public auth routes such as
`/login`, `/auth/*`, and `/app-auth/authorize` are owned by the web-only
`CloudRouterShell`.

### 3. Ask Eliza For App Work

The primary app-builder entry is chat. For a new monetized app, the agent uses
`build-monetized-app` with `eliza-cloud`: register the Cloud app, build the
frontend, publish the frontend deployment, deploy a backend only when server
code is required, configure monetization, and offer a custom domain after the
hosted app exists.

For an existing app, `eliza-cloud` is the management skill: list apps, inspect
analytics, update app config, regenerate API keys, charge users, check
payments, request payouts, manage containers, and call the Cloud APIs.

### 4. Open Cloud Applications When Connected

When Cloud is active, native and desktop runtimes can surface the `cloud-apps`
launcher tile. It opens `/cloud-apps` and lazy-loads the self-contained native
Applications studio.

On the hosted web build, the Applications surface is served by
`CloudRouterShell` through `/dashboard/apps` and `/dashboard/apps/:id`. The
web shell also owns public, auth, payment, approval, invite, app-auth, terms,
privacy, and dashboard compatibility routes.

### 5. Manage Hosted App State In One Applications Surface

The Applications list and app detail screens are the Cloud app management home.
The app detail route is the place for app record settings, app auth/API-key
custody, monetization, earnings, domains, analytics, promotion, users, and
settings.

Managed frontend hosting is real but the dashboard upload UI remains a product
gap. Until that UI lands, the agent/API path owns frontend publish and preview:
`POST /api/v1/apps/:id/frontend`, `GET /api/v1/apps/:id/frontend`,
`POST /api/v1/apps/:id/frontend/:deploymentId/activate`, and
`GET /api/v1/apps/:id/frontend/preview`.

## Hosted Vs Local Split

| Hosted by Eliza Cloud | Stays local / agent-first |
| --- | --- |
| Steward login, session, redirects, and `/app-auth/authorize` | Primary chat, planner, and action loop |
| Web `CloudRouterShell` routes for public/auth/payment/approval/invite/app-auth/terms/privacy/dashboard paths | Launcher, local installed Apps view, local settings, and local model selection |
| Organizations, API keys, credits, usage, billing, Stripe checkout, invoices, and account settings | Local model/device plugins, native connectors, and local provider preference |
| Cloud app records, app API keys, app auth, allowed origins, redirect URIs, app users | Building frontend artifacts and deciding whether server-side code is needed |
| Managed frontend hosting: R2-backed immutable deployments, activation/rollback, preview, public system/custom-domain serving, SEO injection, and page-view beaconing | Local static frontend development and local test serving before publish |
| Custom domains, registrar/DNS/SSL/health checks, verified external domains, and domain money paths | Asking for explicit confirmation before paid domain purchases or ad spend |
| Backend containers, agent server/control-plane provisioning, cloud tunnels, and production worker/container runtime | Avoiding containers for static frontend-only apps |
| Monetization, creator earnings, app charge requests, x402 payment requests, redemptions, admin review | Explaining the requested money move and collecting explicit confirmation |
| Content generation, promotion, advertising, ad inventory, and campaign/account records | Drafting content locally and handing Cloud only durable hosted or paid actions |

## Agent-First Entry Points

- Chat: the user asks Eliza to build, deploy, monetize, promote, debug, or
  manage an app; `eliza-cloud` owns Cloud API operations and
  `build-monetized-app` owns new app launch flow.
- Settings / account / AI model setup: connect Cloud, choose Cloud-backed
  providers, view credits, top up org credits, and disconnect.
- Native/desktop launcher: `cloud-apps` appears only when `cloudActive` is true.
- Hosted web: `/dashboard/apps`, `/dashboard/apps/:id`, `/settings#billing`,
  `/settings#api-keys`, `/dashboard/agents`, and `/dashboard/api-explorer`
  are routed by `CloudRouterShell`.
- Public links: `/login`, `/auth/*`, `/payment/*`, `/approve/*`,
  `/invite/accept`, `/accept-invitation`, `/app-auth/authorize`,
  `/terms-of-service`, and `/privacy-policy`.

## Removed And Unified Surfaces

Current unification already in the repo:

- `packages/cloud-frontend` is deleted. `packages/app` is the single hosted web
  build for both the apex Cloud console and `app.elizacloud.ai`.
- `CloudRouterShell` is web-only. Native and desktop mount the local tab/view
  app directly and use `cloud-apps-view` only for the Applications studio.
- `cloud-apps` is gated by Cloud connection state and must not appear for a
  disconnected user.
- Legacy dashboard routes redirect into the unified app IA:
  `dashboard/build/*` -> `dashboard/my-agents`,
  media/gallery/voices -> `dashboard/api-explorer`,
  containers -> agents,
  agent chat deep links -> agent detail,
  `dashboard/apps/create` -> `dashboard/apps`,
  billing -> `settings#billing`,
  API keys -> `settings#api-keys`,
  documents -> agents.

Targets for sibling cleanup work:

- Keep one Cloud Applications surface for app list/detail, not separate
  launcher tiles for domains, monetization, analytics, promotion, users, or
  frontend deployments.
- Keep one billing/settings entry for credits, checkout, auto top-up,
  developer/API keys, connections, and organization/account management.
- Keep one API Explorer for generation/media/API testing surfaces.
- Keep one Agents surface for hosted agents, containers, instances, and old
  container deep links.
- Put app-specific domains, monetization, earnings, analytics, promote, users,
  frontend deployments, and settings under the app detail route.

## Source Of Truth

- App platform status: `packages/cloud/APP_PLATFORM_REVIEW.md`
- Cloud skill contract: `packages/skills/skills/eliza-cloud/SKILL.md`
- App lifecycle reference:
  `packages/skills/skills/eliza-cloud/references/app-platform-lifecycle.md`
- Cloud router shell: `packages/ui/src/cloud/shell/CloudRouterShell.tsx`
- Cloud route registration: `packages/ui/src/cloud/register-all.ts`
- Applications routes: `packages/ui/src/cloud/applications/index.ts`
- Native Applications tile: `packages/app/src/cloud-apps-view.ts`
- Launcher Cloud gate: `packages/ui/src/components/pages/launcher-curation.ts`
- Hosted web build/proxy: `packages/app/wrangler.toml`,
  `packages/app/functions/_proxy.ts`, `packages/app/src/main.tsx`
- Managed frontend API:
  `packages/cloud/api/v1/apps/[id]/frontend/**/route.ts`
- Public hosted frontend serve path:
  `packages/cloud/api/v1/hosted-frontend/serve/[[...path]]/route.ts`
- Frontend hosting service:
  `packages/cloud/shared/src/lib/services/app-frontend-hosting.ts`
