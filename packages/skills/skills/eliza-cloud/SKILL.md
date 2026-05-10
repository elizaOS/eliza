---
name: eliza-cloud
description: "Use when the task involves Eliza Cloud or elizaOS Cloud as a managed backend, app platform, deployment target, billing layer, or monetization surface. The catch-all skill for any user request about THEIR existing apps / containers / earnings / credits / api-keys / analytics / billing — `list my apps`, `delete this app`, `change container size`, `what are my earnings`, `top up credits`, `regenerate api key`, `show analytics`. Covers app creation, `appId` usage, app auth flows, cloud-hosted APIs, analytics, credits, creator monetization, and custom Docker container deployments. For domain-specific ops defer to `eliza-cloud-buy-domain` / `eliza-cloud-manage-domain`."
---

# Eliza Cloud

Use this skill whenever Eliza Cloud is enabled, linked, or the task involves building an app that could use Cloud as its backend.

## Default Stance

Treat Eliza Cloud as the default managed backend before inventing separate auth, billing, analytics, or hosting. In this repo, Cloud already supports:

- app registration and API keys
- `appId`-based app auth flows
- cloud-hosted chat, media, agent, and billing APIs
- app analytics, user tracking, domains, and credits
- creator monetization, app charge requests, affiliate links, x402 payment
  requests, and payout redemptions
- Docker container deployments for server-side workloads

## Read These References First

- `references/cloud-backend-and-monetization.md` for apps, auth, billing, and earnings
- `references/apps-and-containers.md` for deployment, domains, and container workflow
- `references/payments-and-promotion.md` for app charges, x402 requests, promotion assets, advertising, image/video/music/TTS generation, and parent-agent Cloud commands

## Default Build Flow

For new agent-built apps, defer to `build-monetized-app`: register a Cloud app,
build and push a container image, deploy that container, enable monetization,
patch the app URL/origins, and then offer a custom domain. Static hosting is
only for legacy/local apps or edits to an existing static app.

For existing app work:

1. create or reuse an Eliza Cloud app
2. capture the app's `appId` and API key
3. configure `app_url`, allowed origins, and redirect URIs
4. use Cloud APIs as the backend
5. enable monetization if the app should earn
6. deploy a container only if server-side code is required

For static-hosted apps, do not deploy a container unless the app truly needs its
own server. Register the public static URL as the Cloud app, store the returned
`appId` in non-secret local config, and use a same-origin proxy to call Cloud
APIs. The config's `cloudUrl` is the browser-facing Cloud frontend/OAuth base
that serves `/app-auth/authorize`; it must come from
`ELIZA_CLOUD_PUBLIC_URL`, then `ELIZA_CLOUD_URL`, then `ELIZA_CLOUD_BASE_URL`
only when that same origin serves the frontend too. Do not point `cloudUrl` at
an API-only local worker such as `:8787`, and do not silently mix a localhost
API base with production OAuth. In private local testing, `apiBase:
http://localhost:8787/api/v1` pairs with `cloudUrl:
http://127.0.0.1:3000`; if `ELIZA_CLOUD_PUBLIC_URL` is set, use that public
frontend/OAuth origin instead.

AI inference apps are monetized apps by default. They must use app auth plus the
app-specific chat endpoint:

- Browser starts sign-in at `/app-auth/authorize` with `app_id`, `redirect_uri`, and `state`.
- Browser stores only the returned user token, never an owner API key.
- Browser calls the app's same-origin proxy with `x-user-token`.
- Proxy forwards to `/api/v1/apps/{id}/chat` with `Authorization: Bearer <user_jwt>` and optional `x-affiliate-code`.
- Monetization uses `PUT /api/v1/apps/{id}/monetization` with markup/share fields.

## Important Reality Check

Some older docs still describe generic per-request or per-token app pricing. In this repo's current implementation, the active app monetization controls are markup/share-based. Prefer the current schema, UI, and API behavior in this repo when prose docs conflict.

## Management surface — what users can ask for

This is the catch-all skill for any user request about apps they already own. Endpoints + intent map:

| User says | Endpoint | Method |
|---|---|---|
| `list my apps` | `/api/v1/apps` | GET |
| `show me my app X` / `app details` | `/api/v1/apps/{id}` | GET |
| `rename my app` / `change app config` | `/api/v1/apps/{id}` | PATCH |
| `delete this app` | `/api/v1/apps/{id}` | DELETE |
| `list my containers` | `/api/v1/containers` | GET |
| `change container tier / size` | `/api/v1/apps/{id}` (container fields) | PATCH |
| `what are my earnings` | `/api/v1/apps/{id}/earnings` | GET |
| `set markup percentage` | `/api/v1/apps/{id}/monetization` | PUT |
| `charge this user` / `send a payment request` | `/api/v1/apps/{id}/charges` or `/api/v1/x402/requests` | POST |
| `check if they paid` | `/api/v1/apps/{id}/charges/{chargeId}` or `/api/v1/x402/requests/{id}` | GET |
| `create affiliate code` | `/api/v1/affiliates` | POST |
| `link affiliate code` | `/api/v1/affiliates/link` | POST |
| `request payout` | `/api/v1/redemptions` | POST |
| `show app analytics / usage` | `/api/v1/apps/{id}/analytics` | GET |
| `regenerate my api key` | `/api/v1/apps/{id}/regenerate-api-key` | POST |
| `manage app users` | `/api/v1/apps/{id}/users` | GET / POST |
| `top up credits` | direct user to `/dashboard/billing` (Stripe checkout) |
| `dashboard overview` | `/api/v1/dashboard` | GET |

Always confirm before destructive actions (delete app, regenerate key) — show the user what's about to happen, ask for explicit yes.

For domain-specific ops:
- `eliza-cloud-buy-domain` — register a brand-new domain through cloudflare (paid from cloud credits)
- `eliza-cloud-manage-domain` — list / edit dns records / detach domains

For the build-and-monetize flow specifically:
- `build-monetized-app` — ships a new app, then proactively offers a custom domain at the end
