# Agent-First Eliza Cloud Experience

Issue: #11340
Date: 2026-07-02

This document defines the Eliza Cloud experience from the user's point of view.
The local Eliza agent and its projects stay primary; Cloud is the hosted control
plane for durable identity, billing, publication records, public auth, hosting,
domains, analytics, monetization, and managed backend execution. Cloud wire
surfaces retain the `apps` noun, but creator-facing product copy calls each
published artifact a **published project**.

## Product Contract

- Chat is the first surface. A user can ask Eliza to build, publish, manage,
  monetize, or promote a project before opening its visual management panel.
- Cloud surfaces appear only when they represent hosted state the local app
  cannot own: account connection, credits, publication records, app auth, managed
  frontend deployments, backend containers, domains, analytics, money, and
  public token-gated flows.
- Do not create a second Cloud launcher, a parallel local clone of Cloud app
  management, or standalone tiles for every hosted capability. Fold hosted work
  into each project's Publish tab and reuse the Cloud detail components there.
- A project is the durable creator-owned object. `ProjectRecord.cloudAppId` is
  its only Cloud binding; live status remains in Cloud rather than being cached
  in the local project registry.
- Installed third-party packages are not projects. They stay launchable as
  installed items on the Projects surface and in the launcher runtime.

## Minimal Setup Flow

### 1. First Open: Local Agent Home

The first screen is the local app shell: chat, launcher, local settings, and
local model/device/plugin surfaces. The user can run Eliza without Cloud.

The Projects surface remains usable while Cloud is disconnected. Its Publish
tab shows a designed connection prompt; local creation, coding activity, and
run controls continue to work.

### 2. Connect Cloud From Account Or Model Setup

When the user chooses a Cloud-backed model, account, billing, connector, or
Cloud Dashboard action, the app asks them to connect Eliza Cloud. The current
Cloud Dashboard owns the connected/disconnected state, billing summary,
checkout/top-up affordances, auto top-up settings, and disconnect path.

On the hosted web apex, unauthenticated control-plane visitors are routed to
Steward login instead of the local agent catch-all. Public auth routes such as
`/login`, `/auth/*`, and `/app-auth/authorize` are owned by the web-only
`CloudRouterShell`.

### 3. Ask Eliza For Project Work

The primary project-builder entry is chat. Creating or loading a local
workspace mints a `ProjectRecord`, and coding tasks retain their locked
project/workdir binding. For a monetized publication, the agent uses
`build-monetized-app` with `eliza-cloud`: resolve the project, register or
reactivate its Cloud record, publish the frontend, deploy a backend only when
server code is required and the organization has that capability, configure
inference markup, and offer a custom domain after the publication is live.

For an existing project, `eliza-cloud` is the management skill:
`PUBLISH_PROJECT`, `GET_PUBLISHED_PROJECT`, and `UNPUBLISH_PROJECT` resolve the
local binding before using the stable Cloud APIs. Read-safe analytics, users,
domains, and DNS actions use the same project-aware resolution.

### 4. Open The Project Publish Tab

Projects is the one creator destination at `/apps/tasks`. A project detail owns
Overview, Activity, Run, and Publish tabs. The Publish tab is gated by the
connected Cloud state and leads with managed static hosting, the production
path available to every publishing organization.

The historical `/apps/my-apps`, `/cloud-apps`, and native deploy deep link are
aliases into Projects. Bare `/apps` remains the launcher/game runtime and is
intentionally not repurposed. `CloudRouterShell` continues to own public, auth,
payment, approval, invite, app-auth, terms, privacy, and dashboard compatibility
routes; API/DB/SDK names remain `apps`.

### 5. Manage Hosted State From The Published Project

After publication, the project card shows a live-derived Published badge. Its
Publish tab reuses the Cloud detail suite for status and URLs, managed hosting
versions and rollback, domains, monetization review and inference markup,
earnings, analytics, promotion, users, API-key custody, account-level affiliate
context, unpublish, and deletion.

Managed frontend upload is available in the Publish wizard and Hosting tab as
well as through the agent/API path:
`POST /api/v1/apps/:id/frontend`, `GET /api/v1/apps/:id/frontend`,
`POST /api/v1/apps/:id/frontend/:deploymentId/activate`, and
`GET /api/v1/apps/:id/frontend/preview`.

Container deployment is capability-gated. The wizard and the published
Overview render loading, unavailable, error, and enabled states explicitly; an
ineligible organization never receives a live deploy form.

## Hosted Vs Local Split

| Hosted by Eliza Cloud | Stays local / agent-first |
| --- | --- |
| Steward login, session, redirects, and `/app-auth/authorize` | Primary chat, planner, and action loop |
| Web `CloudRouterShell` routes for public/auth/payment/approval/invite/app-auth/terms/privacy/dashboard paths | Launcher runtime, Projects surface, installed packages, local settings, and local model selection |
| Organizations, API keys, credits, usage, billing, Stripe checkout, invoices, and account settings | Local model/device plugins, native connectors, and local provider preference |
| Cloud publication records, app API keys, app auth, allowed origins, redirect URIs, published-project users | Project registry, coding activity, frontend artifacts, and deciding whether server-side code is needed |
| Managed frontend hosting: R2-backed immutable deployments, activation/rollback, preview, public system/custom-domain serving, SEO injection, and page-view beaconing | Local static frontend development and local test serving before publish |
| Custom domains, registrar/DNS/SSL/health checks, verified external domains, and domain money paths | Asking for explicit confirmation before paid domain purchases or ad spend |
| Backend containers, agent server/control-plane provisioning, cloud tunnels, and production worker/container runtime | Avoiding containers for static frontend-only projects |
| Monetization review, inference-markup earnings, app charge requests, x402 payment requests, redemptions | Explaining the requested money move, hiding stranded purchase-share controls, and collecting explicit confirmation |
| Content generation, promotion, advertising, ad inventory, and campaign/account records | Drafting content locally and handing Cloud only durable hosted or paid actions |

## Agent-First Entry Points

- Chat: the user asks Eliza to build, publish, monetize, promote, debug, or
  manage a project; project-aware actions own the binding and `eliza-cloud`
  owns stable Cloud API operations.
- Settings / account / AI model setup: connect Cloud, choose Cloud-backed
  providers, view credits, top up org credits, and disconnect.
- Projects: `/apps/tasks?projectId=…` owns creation, activity, Run, and
  Cloud-gated Publish management on web, native, and desktop.
- Compatibility: `/apps/my-apps`, `/cloud-apps`, and the native deploy deep
  link enter Projects; `/dashboard/apps*` remains a Cloud wire/console
  compatibility route rather than a second local creator surface.
- Hosted account routes: `/settings#billing`, `/settings#api-keys`,
  `/dashboard/agents`, and `/dashboard/api-explorer` are routed by
  `CloudRouterShell`.
- Public links: `/login`, `/auth/*`, `/payment/*`, `/approve/*`,
  `/invite/accept`, `/accept-invitation`, `/app-auth/authorize`,
  `/terms-of-service`, and `/privacy-policy`.

## Removed And Unified Surfaces

Current unification already in the repo:

- `packages/cloud-frontend` is deleted. `packages/app` is the single hosted web
  build for both the apex Cloud console and `app.elizacloud.ai`.
- Projects is the single creator surface. `MyAppsView`, `NativeAppsStudio`, and
  the native `cloud-apps-view` mount are deleted; historical routes redirect
  into `/apps/tasks`.
- Cloud connection gates only the per-project Publish tab. Projects, local
  coding activity, Run controls, and installed items remain available offline.
- Managed frontend upload, activation, rollback, domains, monetization,
  earnings, analytics, promotion, users, and settings are reused inside the
  published project's detail view.
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

- Keep one Projects surface for creator-owned local and published state, not
  separate launcher tiles for publication, domains, monetization, analytics,
  promotion, users, or frontend deployments.
- Keep one billing/settings entry for credits, checkout, auto top-up,
  developer/API keys, connections, and organization/account management.
- Keep one API Explorer for generation/media/API testing surfaces.
- Keep one Agents surface for hosted agents, containers, instances, and old
  container deep links.
- Put project publication domains, monetization, earnings, analytics, promote,
  users, frontend deployments, and settings under the project's Publish tab.

## Source Of Truth

- App platform status: `packages/cloud/APP_PLATFORM_REVIEW.md`
- Cloud skill contract: `packages/skills/skills/eliza-cloud/SKILL.md`
- App lifecycle reference:
  `packages/skills/skills/eliza-cloud/references/app-platform-lifecycle.md`
- Consolidation contract:
  `packages/docs/ongoing-development/research/10-projects-apps-consolidation.md`
- Project registry: `packages/core/src/utils/project-registry.ts`
- Projects surface:
  `packages/ui/src/components/pages/TasksPageView.tsx`
- Project publication panel:
  `packages/ui/src/cloud/applications/components/project-publish-panel.tsx`
- Cloud router shell: `packages/ui/src/cloud/shell/CloudRouterShell.tsx`
- Cloud route registration: `packages/ui/src/cloud/register-all.ts`
- Applications routes: `packages/ui/src/cloud/applications/index.ts`
- Launcher curation: `packages/ui/src/components/pages/launcher-curation.ts`
- Hosted web build/proxy: `packages/app/wrangler.toml`,
  `packages/app/functions/_proxy.ts`, `packages/app/src/main.tsx`
- Managed frontend API:
  `packages/cloud/api/v1/apps/[id]/frontend/**/route.ts`
- Public hosted frontend serve path:
  `packages/cloud/api/v1/hosted-frontend/serve/[[...path]]/route.ts`
- Frontend hosting service:
  `packages/cloud/shared/src/lib/services/app-frontend-hosting.ts`
