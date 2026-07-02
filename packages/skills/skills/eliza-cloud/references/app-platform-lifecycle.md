# Eliza Cloud App Platform Lifecycle

Use this reference when a user asks to create, host, deploy, monetize, promote,
or operate an Eliza Cloud app.

## Product Contract

The Cloud app record is the product identity. Attach capabilities to that app
record instead of inventing separate per-feature identities.

Use this order:

1. Create or reuse an app: `POST /api/v1/apps`.
2. Configure browser auth: `app_url`, `allowed_origins`, redirect URIs, and the
   public app URL.
3. Decide how the frontend is hosted.
4. Deploy a backend container only if server-side code is required.
5. Attach or buy a domain.
6. Enable monetization and earnings if the app should make money.
7. Add analytics, SEO, content generation, and promotion/ads as app-level
   features.
8. Capture evidence: screenshots/video for UI, logs, DB rows, provider
   artifacts, and money-path records.

## Current Hosting Reality

Cloud has first-class app records, app auth, managed frontend hosting, backend
container deploys, custom domains, analytics, monetization, promotion,
advertising, and content generation.

Use this hosting split:

- For static frontend-only apps, publish the built site with
  `POST /api/v1/apps/:id/frontend` or the `DEPLOY_FRONTEND` agent action. Cloud
  content-addresses the files to R2, creates an immutable frontend deployment,
  and can activate it immediately. `GET /api/v1/apps/:id/frontend` lists
  deployments and the active id.
- Preview the active or selected deployment at
  `/api/v1/apps/:id/frontend/preview`.
- Public traffic is served from the app's system frontend host or a verified
  active custom domain through the Cloud Worker/R2 serve path. Cloud injects SEO
  metadata and a page-view analytics beacon into document responses and records
  the page view server-side.
- Activate an older deployment with
  `POST /api/v1/apps/:id/frontend/:deploymentId/activate` to roll back.
- Use an external/static host only when the app intentionally should not use
  Cloud managed frontend hosting; register that URL in `app_url` and
  `allowed_origins`.
- Deploy a backend container only when the app needs server-side code.

Remaining product/operator gaps: dashboard upload/activate/rollback UI,
production DNS/wildcard host pointing for all managed frontend hosts, and the
remaining session/funnel analytics tail.

## Backend Container Rule

Use a container only for real server-side work:

- API routes or custom server logic
- webhooks
- background jobs
- existing Dockerized apps
- private server-side credentials

Do not use a container when Cloud APIs plus a static frontend are enough.

## Domain Rule

Prefer the existing app domain model:

- check availability and pricing before buying,
- confirm exact spend before a managed domain purchase,
- attach external domains through TXT verification,
- use status/health routes to verify DNS and SSL,
- record purchase ids and cleanup notes for live tests.

Domain purchase is a money path. Never start it from a worker without explicit
parent/user confirmation.

## Analytics And SEO Rule

Cloud records API/request analytics and hosted-frontend page views. Session and
funnel analytics are still product gaps.

For managed frontend hosting, Cloud owns the response and can inject metadata,
SEO tags, page-view beaconing, `robots.txt`, `sitemap.xml`, and structured data
at the serving layer. For external hosts, Cloud cannot reliably inject into the
response; return the metadata for the app builder to install in that frontend.

## Promotion, Advertising, And Content

Use app-scoped content generation and promotion only after the destination URL
is real.

- Generate images/video/music/prompts through the Cloud generation routes.
- Store successful promotional assets on the app record where available.
- Create ad accounts/campaigns/creatives as drafts first.
- Do not start ad delivery without account ownership, platform policy,
  destination URL, approved creative, audience, and explicit budget
  confirmation.
- Influencer marketplace, PR distribution, publisher ad inventory, and more ad
  networks are separate growth workstreams.

## Source Map

- Platform review: `packages/cloud/APP_PLATFORM_REVIEW.md`
- Agent-first experience plan: `packages/cloud/AGENT_FIRST_EXPERIENCE.md`
- App routes: `packages/cloud/api/v1/apps/**/route.ts`
- Frontend routes: `packages/cloud/api/v1/apps/[id]/frontend/**/route.ts`
- Hosted frontend serve route:
  `packages/cloud/api/v1/hosted-frontend/serve/[[...path]]/route.ts`
- Domain routes: `packages/cloud/api/v1/apps/[id]/domains/**/route.ts`
- Backend deploy: `packages/cloud/api/v1/apps/[id]/deploy/route.ts`
- App schema: `packages/cloud/shared/src/db/schemas/apps.ts`
- Frontend deployment schema:
  `packages/cloud/shared/src/db/schemas/app-frontend-deployments.ts`
- Frontend hosting service:
  `packages/cloud/shared/src/lib/services/app-frontend-hosting.ts`
- Deploy services: `packages/cloud/shared/src/lib/services/app-deployments.ts`,
  `app-deploy-orchestrator.ts`
- Promotion: `packages/cloud/shared/src/lib/services/app-promotion.ts`,
  `app-promotion-assets.ts`
- SEO: `packages/cloud/shared/src/lib/services/seo.ts`
- Advertising: `packages/cloud/shared/src/lib/services/advertising/`
- Content generation: `packages/cloud/shared/src/lib/services/generations.ts`
