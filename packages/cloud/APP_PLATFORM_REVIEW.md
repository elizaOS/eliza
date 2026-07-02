# Eliza Cloud App Platform Review

Issue: #10690
Date: 2026-07-01

This review maps the current Cloud app platform and fixes the product contract
that agents should follow for the app record, managed frontend host, backend
container, domain, analytics, monetization, and promotion lifecycle.

## Current Platform Map

| Surface | Current owner files | Current state |
| --- | --- | --- |
| App lifecycle | `packages/cloud/api/v1/apps/route.ts`, `packages/cloud/api/v1/apps/[id]/route.ts`, `packages/cloud/shared/src/db/schemas/apps.ts`, `packages/cloud/shared/src/lib/services/apps.ts`, `packages/cloud/shared/src/lib/services/app-factory.ts` | Real. Apps are org-owned, have API keys, `app_url`, `allowed_origins`, `production_url`, GitHub repo metadata, deployment state, monetization fields, automation config, promotional assets, and usage counters. |
| Backend hosting | `packages/cloud/api/v1/apps/[id]/deploy/route.ts`, `packages/cloud/api/v1/apps/[id]/deploy/status/route.ts`, `packages/cloud/shared/src/lib/services/app-deploy-orchestrator.ts`, `packages/cloud/shared/src/lib/services/app-deployments.ts`, `packages/cloud/shared/src/db/schemas/containers.ts`, `packages/cloud/shared/src/db/schemas/app-databases.ts`, `packages/cloud/services/container-control-plane/` | Real but production-gated. Container deploys are queued, quota-checked, billed, and run through the control-plane/Hetzner path when `APPS_DEPLOY_ENABLED=1` and the org allowlist permits it. |
| Custom domains | `packages/cloud/api/v1/apps/[id]/domains/*/route.ts`, `packages/cloud/api/v1/domains/*/route.ts`, `packages/cloud/shared/src/db/schemas/app-domains.ts`, `packages/cloud/shared/src/db/schemas/managed-domains.ts`, `packages/cloud/shared/src/lib/services/managed-domains.ts`, `packages/cloud/shared/src/lib/services/domain-pricing.ts`, `packages/cloud/shared/src/lib/services/domain-health.ts`, `packages/cloud/shared/src/lib/services/domain-renewals.ts` | Real. Managed buys, external verification, DNS, SSL/status, health, and renewals exist. Live registration is money/secret gated and tracked by #10621/#10691. |
| Analytics | `packages/cloud/api/v1/apps/[id]/analytics/route.ts`, `packages/cloud/api/v1/apps/[id]/analytics/requests/route.ts`, `packages/cloud/api/v1/apps/[id]/users/route.ts`, `packages/cloud/api/v1/hosted-frontend/serve/[[...path]]/route.ts`, `packages/cloud/shared/src/db/schemas/apps.ts`, `packages/cloud/shared/src/lib/services/app-analytics.ts`, `packages/cloud/shared/src/lib/services/analytics.ts`, `packages/cloud/shared/src/lib/services/analytics-derived.ts` | Real for API/request analytics and hosted-frontend page views. Session/funnel analytics remain a product tail. |
| SEO and promotion | `packages/cloud/api/v1/apps/[id]/promote/route.ts`, `packages/cloud/api/v1/apps/[id]/promote/preview/route.ts`, `packages/cloud/api/v1/apps/[id]/promote/assets/route.ts`, `packages/cloud/shared/src/lib/services/app-promotion.ts`, `packages/cloud/shared/src/lib/services/app-promotion-assets.ts`, `packages/cloud/shared/src/lib/services/seo.ts`, `packages/cloud/shared/src/lib/services/app-frontend-hosting.ts` | Real. SEO can generate metadata/artifacts; managed frontend hosting injects metadata at response time, synthesizes `robots.txt`/`sitemap.xml` when absent, and external hosts still need the builder to install metadata manually. |
| Advertising and growth | `packages/cloud/api/v1/advertising/**/route.ts`, `packages/cloud/shared/src/lib/services/advertising/`, `packages/cloud/shared/src/db/schemas/ad-accounts.ts`, `ad-campaigns.ts`, `ad-creatives.ts`, `ad-transactions.ts` | Real for advertiser-side Google/Meta/TikTok campaign/account/creative paths. Influencer marketplace, PR distribution, publisher inventory/SSP, brand approval, and more networks are tracked by #10687. |
| Content generation | `packages/cloud/api/v1/generate-image/route.ts`, `generate-video/route.ts`, `generate-music/route.ts`, `generate-prompts/route.ts`, `packages/cloud/api/v1/apps/[id]/generate-image/route.ts`, `packages/cloud/shared/src/lib/services/generations.ts`, `packages/cloud/shared/src/db/schemas/generations.ts`, `packages/cloud/shared/src/lib/providers/image/` | Real for image, video, music, and prompt generation. Files/assets CRUD, video/audio provider registries, provider roster expansion, and scenario coverage are tracked by #10688/#10689. |
| Agent skill contract | `packages/skills/skills/eliza-cloud/SKILL.md`, `references/apps-and-containers.md`, `references/cloud-backend-and-monetization.md`, `references/payments-and-promotion.md` | Real but needed a unified lifecycle reference. This PR adds `references/app-platform-lifecycle.md` and points the skill at it. |

## Platform Contract

The durable integration unit is the Cloud app record. Every self-serve app
capability should attach to the app record, not to one-off routes:

1. Create or reuse an org-owned app.
2. Configure app auth: `app_url`, `allowed_origins`, redirect URIs, and API key
   custody.
3. Choose frontend hosting.
4. Deploy a backend container only when server-side code is required.
5. Attach a managed or verified custom domain.
6. Enable monetization, usage billing, creator earnings, and payout paths.
7. Add content generation, promotion, SEO, advertising, and analytics.
8. Prove the full lifecycle through scenario evidence.

The app record is already the shared key for auth, domains, analytics,
monetization, promotion assets, content generation, and backend deploy. New
surfaces should extend that contract instead of creating parallel product
identities.

## Frontend Hosting Decision

Managed frontend hosting has landed on the recommended Worker/R2 static-host
shape. The platform can now own user frontend artifacts without forcing a
backend container for static apps.

Implemented shape:

- Immutable frontend build artifacts are stored in R2 under an org/app/deployment
  prefix.
- `app_frontend_deployments` points an app at the active manifest, build
  metadata, content hash, and rollback target.
- Hosted frontend responses are served through the Cloud Worker route or app
  hostname handler so Cloud can inject analytics beacons, SEO metadata, security
  headers, cache policy, and app-auth bootstrap consistently.
- Container hosting remains for server-side workloads. Do not force a container
  for static frontend-only apps.
- Existing app domains can target either the hosted frontend, backend container,
  or an app-level routing policy.

Why this path:

- It uses the existing Cloudflare Worker/R2 operating model and bindings.
- It avoids provisioning one Cloudflare Pages project per user app.
- It gives Cloud control over SEO and page analytics at response time.
- It keeps the frontend and backend lifecycles separate while preserving one
  app/product identity.

## Required Implementation Slices

> Status (#10690): slices 1–3 are **implemented** — `app_frontend_deployments`
> (immutable, content-addressed, R2-backed) + repository + `AppFrontendHostingService`
> (`packages/cloud/shared/src/lib/services/app-frontend-hosting.ts`), the
> `apps/[id]/frontend` routes (publish/list/detail/activate-rollback/preview),
> the public `hosted-frontend/serve` path with host→app resolution, SEO `<head>`
> injection + a page-view beacon + server-side page-view recording, and the
> `DEPLOY_FRONTEND` agent action + SDK methods. Remaining: session/funnel
> analytics (slice 3 tail), the dashboard upload UI (slice 4), and pointing
> production DNS/wildcard hosts at the Worker (operator, tracked with the
> domain money-path in #10621).

1. Frontend artifact model and routes:
   - schema/repository for frontend deployments and active manifest
   - upload/finalize/list/activate/rollback routes under `apps/[id]/frontend`
   - R2 object prefix policy and manifest validation
2. Hosted frontend serve path:
   - route/hostname resolution from app/domain to active frontend manifest
   - fallback to app container or external `app_url` when no frontend deployment
     exists
   - cache headers and safe content-type handling
3. SEO and page analytics:
   - metadata injection from app/SEO artifacts
   - `robots.txt` and `sitemap.xml` ownership for hosted frontends
   - lightweight page-view/session/funnel beacon tied to `appAnalytics` or a
     sibling page analytics table
4. Skill and UI lifecycle:
   - dashboard trigger for upload/activate/rollback
   - `eliza-cloud` skill steps for create -> host frontend -> deploy backend ->
     buy/attach domain -> analytics/SEO -> ads/content
5. Evidence:
   - non-CI app/domain money-path scenario from #10691
   - app-platform walkthrough with screenshots/video once UI exists
   - DB rows, logs, hosted URL, and domain artifacts per `PR_EVIDENCE.md`

## Generality And Access Review

| Capability | Access state | Required policy |
| --- | --- | --- |
| App CRUD/auth | Available to authenticated org users/API keys | Keep org isolation and API-key custody enforced. |
| Backend deploy | Production-gated by env and org allowlist | Keep gate until #10621 deploy image/secrets/staging evidence are done; expose clear 503/403 errors. |
| Domains | Available by route, but live registrar depends on production keys and credits | Use #10691 for real purchase evidence; all paid buys need explicit confirmation. |
| Analytics | Available for API/request paths and hosted frontend page views | Add session/funnel analytics after the page-view base is stable. |
| SEO | Available as artifacts/provider calls and managed-host response injection | External frontends still need the builder to install metadata. |
| Advertising | Advertiser-side paid campaigns exist | Do not start spend without account ownership, policy, destination URL, creative, audience, and budget confirmation. |
| Content generation | General media generation exists | Add files/assets CRUD and provider registries before treating generated assets as a managed library. |

## Cross-Issue Coordination

- #10621: GA operator gate for deployment secrets, image digest, staging e2e,
  payout, and registrar money paths.
- #10687: advertising and growth marketplace, including influencer, PR, ad
  inventory, more networks, approval, and publisher revenue.
- #10688: content-generation API completion and files/assets CRUD.
- #10689: Atlas video and video provider registry.
- #10691: non-CI full app create/deploy/domain-buy money-path scenario.
- #10692: any-device GitHub/device-code connect for fresh cloud agents.
- #8434: launch tracker that should consume the evidence from these slices.

## Done Criteria For The Umbrella

#10690 should stay open until a reviewer can verify, without reading code:

- a fresh user creates an app,
- uploads or generates a hosted frontend,
- deploys a backend container if needed,
- buys or attaches a domain,
- sees page and API analytics,
- applies SEO metadata,
- generates content assets,
- runs or schedules promotion/ads with explicit confirmation,
- and captures screenshots, video, logs, DB rows, hosted URLs, provider
  artifacts, and money-path evidence.
