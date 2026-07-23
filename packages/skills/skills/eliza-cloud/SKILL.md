---
name: eliza-cloud
description: "Use when the task involves Eliza Cloud or elizaOS Cloud as a managed backend, project-publishing target, billing layer, or monetization surface. The catch-all skill for requests about publishing or managing the user's projects, containers, earnings, credits, API keys, analytics, billing, payment requests, or payouts — `publish my project`, `show my published projects`, `unpublish this project`, `what are its analytics`, `change container size`, `what are my earnings`, `top up credits`, `charge this user`, `request payout`, or `regenerate the API key`. Covers the stable Cloud `apps` API, appId auth flows, managed hosting, analytics, credits, charges, x402 requests, affiliate links, creator monetization, payout redemptions, and custom Docker container deployments. For domain-specific operations defer to `eliza-cloud-buy-domain` / `eliza-cloud-manage-domain`."
---

# Eliza Cloud

Use this skill whenever Eliza Cloud is enabled, linked, or the task involves
publishing a project or using Cloud as its backend.

## Default Stance

Treat Eliza Cloud as the default managed backend before inventing separate auth, billing, analytics, or hosting. In this repo, Cloud already supports:

- app registration and API keys
- `appId`-based app auth flows
- cloud-hosted chat, media, agent, and billing APIs
- app analytics, user tracking, domains, and credits
- creator monetization, app charge requests, affiliate links, x402 payment
  requests, and payout redemptions
- Docker container deployments for server-side workloads
- on-demand cloud tunnel provisioning for agents through Headscale-backed
  Tailscale sessions

## Read These References First

- `references/cloud-backend-and-monetization.md` for apps, auth, billing, and earnings
- `references/apps-and-containers.md` for deployment, domains, and container workflow
- `references/app-platform-lifecycle.md` for the unified app platform contract,
  current frontend-hosting reality, and app lifecycle order
- `references/payments-and-promotion.md` for app charges, x402 requests, local billing proxy aliases, payout redemptions, promotion assets, advertising, image/video/music/TTS generation, and parent-agent Cloud commands

## Skill Pairing

Use `build-monetized-app` alongside this skill for any project that should be
published and earn money. `build-monetized-app` owns the build, publish,
monetize, and custom-domain offer flow; `eliza-cloud` owns the stable Cloud
backend surface, published-project management, app charge requests, x402
requests, affiliate earnings, payout redemptions, media/promotion, and
account-bound parent-agent commands. Spawned code agents should load or request
both skills for published-project builds.

## Default Build Flow

For new work, defer to `build-monetized-app`: resolve or create a local project,
publish it by creating or reusing its bound Cloud app record, publish the
frontend, deploy a container only if the project needs server-side code, enable
monetization, and then offer a custom domain.

Managed frontend hosting is now first-class. To publish a complete project on
Cloud:

1. Resolve the active project and its `cloudAppId`; use `PUBLISH_PROJECT` for
   the complete transition.
2. Create or reuse the project's bound Cloud app record. Never keep a second
   project-to-app mapping.
3. **Publish the frontend**: `POST /api/v1/apps/:id/frontend` with the built site
   files (or the `DEPLOY_FRONTEND` agent action pointed at the build directory,
   e.g. `./dist`). Cloud content-addresses the files to R2, finalizes an
   immutable deployment, and activates it. The active deployment is served with
   SEO metadata + a page-view analytics beacon injected at response time.
   - Deployments are immutable + versioned: `POST .../frontend/:deploymentId/activate`
     switches the live version, which is also **rollback** (activate an older one).
   - `GET .../frontend` lists deployments + the active id.
4. **Deploy a backend container** only when the project needs server-side code
   (`POST /api/v1/apps/:id/deploy`). A static/frontend-only project does not
   need one.
5. **Attach a custom domain** (`domains/buy` + attach), or use the project's system
   frontend host. The same domain can target the hosted frontend or a backend.

The public site is served by Cloud at the app's frontend host / verified custom
domain (operator DNS points the host at the Cloud Worker). Until a host is
pointed at Cloud, preview the active deployment at
`/api/v1/apps/:id/frontend/preview`.

For an existing project:

1. resolve the project and its bound `cloudAppId`
2. publish or reactivate it when the user asks
3. configure `app_url`, allowed origins, and redirect URIs on the Cloud record
4. use Cloud APIs as the backend
5. enable monetization if the published project should earn
6. deploy a container only if server-side code is required

For static-hosted projects, do not deploy a container unless the project truly
needs its own server. Bind the Cloud record to the project, publish the static
frontend, store the returned `appId` in non-secret runtime config, and use a
same-origin proxy to call Cloud APIs. The config's `cloudUrl` is the
browser-facing Cloud frontend/OAuth base
that serves `/app-auth/authorize`; it must come from
`ELIZA_CLOUD_PUBLIC_URL`, then `ELIZA_CLOUD_URL`, then `ELIZA_CLOUD_BASE_URL`
only when that same origin serves the frontend too. Do not point `cloudUrl` at
an API-only local worker such as `:8787`, and do not silently mix a localhost
API base with production OAuth. In private local testing, `apiBase:
http://localhost:8787/api/v1` pairs with `cloudUrl:
http://127.0.0.1:3000`; if `ELIZA_CLOUD_PUBLIC_URL` is set, use that public
frontend/OAuth origin instead.

Published AI inference projects are monetized through their Cloud app record by
default. They must use app auth plus the app-specific chat endpoint:

- Browser starts sign-in at `/app-auth/authorize` with `app_id`, `redirect_uri`, and `state`.
- Browser stores only the returned user token, never an owner API key.
- Browser calls the app's same-origin proxy with `x-user-token`.
- Proxy forwards to `/api/v1/apps/{id}/chat` with `Authorization: Bearer <user_jwt>`. The app-scoped chat route does **not** read `x-affiliate-code` — for affiliate-attributed inference send `POST /api/v1/messages` with `x-app-id` + `x-affiliate-code` instead (see `build-monetized-app`).
- Monetization uses `PUT /api/v1/apps/{id}/monetization` with markup/share fields.

## Important Reality Check

Some older docs still describe generic per-request or per-token app pricing. In this repo's current implementation, the active app monetization controls are markup/share-based. Prefer the current schema, UI, and API behavior in this repo when prose docs conflict.

## Payment And Money Flow Rules

Pick the narrowest money surface:

- **App monetization** (`PUT /api/v1/apps/{id}/monetization`) sets ongoing inference markup and app-credit purchase share. The inference markup is added to the cost debited from the caller's ORG credit balance and earned via `recordCreatorEarnings`; the purchase-share applies to the (currently stranded) per-app pool. It is not a one-off invoice.
- **App charge requests** (`POST /api/v1/apps/{id}/charges`) ask a user to pay an exact USD amount through Stripe or OxaPay. The payer receives app credits; creator earnings flow through the app-credit earnings ledger.
- **x402 payment requests** (`POST /api/v1/x402/requests`) ask for direct crypto settlement. Use these when the payer already has crypto or the flow is wallet-native. Current settlement support includes Base, Ethereum, BSC, and Solana; defaults point at `https://x402.elizacloud.ai`.
- **App-credit checkout** (`POST /api/v1/app-credits/checkout`) buys into the per-app pre-purchased credit pool (`app_credit_balances`). Note: inference billing was migrated to the org balance, so these purchases are currently stranded (issue #8253) — prefer org-credit checkout for spendable balance. Use app charge requests when the agent needs a durable request, metadata, callbacks, and a reusable payment URL.
- **Org-credit checkout** (`POST /api/v1/credits/checkout`) tops up the user's organization. It is not creator pricing.
- **Cloud tunnel provisioning** (`POST /api/v1/apis/tunnels/tailscale/auth-key`) debits org credits once per successful tunnel auth-key mint. It is on-demand infrastructure usage, not SaaS/subscription billing.
- **Redemptions** (`POST /api/v1/redemptions`) request creator payout in elizaOS tokens on `base`, `bsc`/`bnb`, `ethereum`, or `solana`. Payouts are fixed to the USD quote at request time and then admin reviewed/processed.

For agent-initiated charges, always include callback channel metadata when a
conversation should get the payment result:

```json
{ "callback_channel": { "roomId": "room-id", "agentId": "agent-id" } }
```

On success or failure, the Cloud payment services can write back to that same
room so the agent can tell the user whether the payment went through.

When running inside the local `@elizaos/plugin-elizacloud` route plugin, use
`/api/cloud/billing/*` aliases instead of exposing Cloud credentials to browser
or app code. They proxy to the real Cloud API and preserve x402 payment headers:

- `/api/cloud/billing/x402/*` -> `/api/v1/x402/*`
- `/api/cloud/billing/apps/{appId}/charges/*` -> `/api/v1/apps/{appId}/charges/*`
- `/api/cloud/billing/apps/{appId}/earnings/*` -> `/api/v1/apps/{appId}/earnings/*`
- `/api/cloud/billing/apps/{appId}/monetization` -> `/api/v1/apps/{appId}/monetization`
- `/api/cloud/billing/app-credits/*` -> `/api/v1/app-credits/*`
- `/api/cloud/billing/affiliates/*` -> `/api/v1/affiliates/*`
- `/api/cloud/billing/redemptions/*` -> `/api/v1/redemptions/*`

Do not hand-calculate payment totals. The creator supplies the requested amount;
Cloud returns platform/service fees, total charged amount, headers, URLs, and
status fields. Show or store the returned values.

## Management surface — what users can ask for

This is the catch-all skill for requests about projects the user wants to
publish or has already published. Product-level project actions resolve
`ProjectRecord.cloudAppId`; the endpoint column names the stable Cloud wire
surface underneath them.

| User says | Action / endpoint | Method |
|---|---|---|
| `publish my project` | `PUBLISH_PROJECT` → `/api/v1/apps` + hosting route | create/reactivate + deploy |
| `how is my published project doing?` | `GET_PUBLISHED_PROJECT` | read status, URL, analytics, earnings |
| `unpublish this project` | `UNPUBLISH_PROJECT` → `/api/v1/apps/{id}` | PATCH `is_active:false` |
| `list my projects` | `LIST_PROJECTS` → `/api/projects` | GET |
| `show me project X` | `GET_PROJECT` → `/api/projects` | GET |
| `make this the active project` | `SET_ACTIVE_PROJECT` → `/api/projects/{id}/activate` | POST |
| `show my published projects` | `/api/v1/apps` | GET |
| `rename the publication` / `change Cloud config` | `/api/v1/apps/{id}` | PATCH |
| `delete the published artifact` | `/api/v1/apps/{id}` | DELETE |
| `list my containers` | `/api/v1/containers` | GET |
| `change container tier / size` | `/api/v1/apps/{id}` (container fields) | PATCH |
| `what are my earnings` | `/api/v1/apps/{id}/earnings` | GET |
| `set markup percentage` | `/api/v1/apps/{id}/monetization` | PUT |
| `charge this user` / `send a payment request` | `/api/v1/apps/{id}/charges` or `/api/v1/x402/requests` | POST |
| `check if they paid` | `/api/v1/apps/{id}/charges/{chargeId}` or `/api/v1/x402/requests/{id}` | GET |
| `create checkout for that charge` | `/api/v1/apps/{id}/charges/{chargeId}/checkout` | POST |
| `create affiliate code` | `/api/v1/affiliates` | POST |
| `link affiliate code` | `/api/v1/affiliates/link` | POST |
| `show payout balance` | `/api/v1/redemptions/balance` | GET |
| `quote payout` | `/api/v1/redemptions/quote` | GET |
| `request payout` | `/api/v1/redemptions` | POST |
| `show project analytics / usage` | `GET_APP_ANALYTICS` → `/api/v1/apps/{id}/analytics` | GET |
| `regenerate my api key` | `/api/v1/apps/{id}/regenerate-api-key` | POST |
| `list project users` | `LIST_APP_USERS` → `/api/v1/apps/{id}/users` | GET |
| `top up org credits` | `/api/v1/credits/checkout` or `/dashboard/billing` | POST / hosted |
| `top up app credits` | `/api/v1/app-credits/checkout` | POST |
| `start/provision a cloud tunnel` | `/api/v1/apis/tunnels/tailscale/auth-key` via `@elizaos/plugin-tailscale` | POST |
| `dashboard overview` | `/api/v1/dashboard` | GET |

Cloud tunnels are multi-tenant by construction: callers must authenticate as an
active Cloud user or API key with an organization, provisioning consumes org
credits immediately, keys are short-lived/non-reusable/ephemeral, the server
forces `tag:eliza-tunnel`, and the public proxy only forwards generated
signed `eliza-<org>-<random>-<expiry>-<signature>` hostnames into the Headscale
tailnet. Signed public hostnames expire with the tunnel provisioning window.

Always confirm before unpublishing, deleting the Cloud artifact, regenerating a
key, spending money, or moving money. State exactly which project and Cloud
artifact will change before requesting explicit confirmation.

For domain-specific ops:
- `eliza-cloud-buy-domain` — register a brand-new domain through cloudflare (paid from cloud credits)
- `eliza-cloud-manage-domain` — list / edit dns records / detach domains

For the build-and-monetize flow specifically:
- `build-monetized-app` — publishes a project, then proactively offers a custom domain at the end

## Monetization & promotion surfaces (ads + influencers)

Beyond inference markup / purchase share, a published project can **earn from
ads** and the agent can **promote** by hiring influencers — reusing existing
credit + earnings rails only (no new payment infra).

**Ad inventory / SSP — the published project *sells* ad placements and earns.**

| User says | Endpoint | Method | Agent action |
|---|---|---|---|
| `monetize my project with ads` / `sell ad space` | `/api/v1/marketing/inventory` | POST | `CREATE_AD_SLOT` |
| `show my ad slots / ad earnings` | `/api/v1/marketing/inventory` | GET | `LIST_AD_SLOTS` |
| `pause/edit an ad slot` | `/api/v1/marketing/inventory/{slotId}` | PATCH/DELETE | — |
| `ad slot analytics` | `/api/v1/marketing/inventory/{slotId}/analytics` | GET | — |

The public `…/inventory/serve?slot=` + `…/inventory/click` endpoints are the
miniapp's ad tag (they fill a slot with an eligible campaign, debit the
advertiser exactly once, and credit the publisher's redeemable earnings).

**Influencer marketplace — publish a profile to earn, or hire influencers to promote.**

| User says | Endpoint | Method | Agent action |
|---|---|---|---|
| `list me as an influencer` / `offer promo services` | `/api/v1/marketing/influencers` | POST | `CREATE_INFLUENCER_PROFILE` |
| `find/hire an influencer` | `/api/v1/marketing/influencers?niche=` | GET | `LIST_INFLUENCERS` |
| `book/hire X to promote for $Y` | `/api/v1/marketing/influencers/bookings` | POST | `BOOK_INFLUENCER` (money — two-step confirm) |
| influencer accepts / delivers | `…/bookings/{id}/accept` \| `…/deliver` | POST | — |
| advertiser approves (releases escrow) / rejects / cancels (refunds) | `…/bookings/{id}/approve` \| `reject` \| `cancel` | POST | — |

Booking is **escrowed**: the advertiser's org credits are debited when the offer
is funded, released to the influencer on approval, or refunded on
reject/cancel (the influencer can decline from `offered` or `accepted`). Every
money move is idempotent on the booking id and runs before the status
finalizes, so a failed payout/refund leaves a retryable state and a retry moves
money at most once. `BOOK_INFLUENCER` never moves money on the first ask; it
funds only on an explicit structured confirmation (and sends a per-confirmation
idempotency key so a transport retry cannot fund twice).

Together with managed **frontend hosting** (publish a complete project site via
`DEPLOY_FRONTEND` / `/api/v1/apps/{id}/frontend`), this is the complete agent
loop: **build → host a project → deploy backend → attach a domain → monetize
(markup / purchase / ads) → promote (influencers) → track earnings → pay out.**
