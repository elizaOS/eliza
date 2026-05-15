# eDad Chat — the dad you never had (chat-in-place variant)

A different pattern from `apps/edad/`: instead of creating a character on Eliza Cloud and redirecting users to `cloud/chat/<characterId>`, this variant **keeps the chat UI on the app's own domain** and proxies `/v1/messages` calls to Eliza Cloud with the app + affiliate code attached as headers.

Shipped live at **https://eliza.nubs.site/apps/edad/** by RemilioNubilio.

## Why this pattern exists

- Keeps users on the miniapp's domain end-to-end (branding, UX continuity, embeddable elsewhere)
- Users sign in to Eliza Cloud once and chat with their own org credit balance — no per-app credit pool to top up
- App creator earns the inference markup % on every reply via `recordCreatorEarnings`; affiliate code adds a separate share
- No character registration, no anonymous session management — lean proxy + minimal frontend

## How it works

```
browser                                app backend                       eliza cloud
┌──────────────────┐                  ┌──────────────────┐              ┌───────────────────┐
│ index.html       │  POST /api/msgs  │ proxy.ts         │  /v1/messages │ debits user's    │
│ + chat UI JS     │─────────────────▶│ adds x-app-id    │──────────────▶│ org balance      │
│                  │                  │ + x-affiliate-   │              │ adds markup → me │
│ Steward JWT      │                  │   code header    │              │ creator earnings │
│ (OAuth required) │                  │ + Authorization  │              │ + affiliate share│
└──────────────────┘                  └──────────────────┘              └───────────────────┘
```

## Files

| file | purpose |
|---|---|
| `public/index.html` | landing + chat UI + OAuth sign-in + message loop |
| `public/style.css` | dad-energy dark theme, SVG silhouette, responsive |
| `public/meta.json` | app index metadata |
| `api/proxy.ts` | Next.js-style catch-all route handler — used when edad-chat is mounted under a host Next.js app at `/api/*` |
| `server.ts` | standalone Bun server with the same wire behavior as `api/proxy.ts` — used when edad-chat runs as its own container |
| `Dockerfile` | bun:1.2-alpine image, exposes :3000, includes `/health` for ECS health checks |

## Env required

```bash
ELIZA_APP_ID=<uuid of app registered via POST /api/v1/apps>
ELIZA_CLOUD_URL=https://www.elizacloud.ai
ELIZA_AFFILIATE_CODE=AFF-XXXXXX     # your affiliate code — drives per-call affiliate share earnings
```

There is **no operator-paid fallback**. The proxy rejects requests without a Steward JWT with 401. Reasoning:

- The whole point of monetization is that creators + affiliates earn a real cut of the *user's* credits. An operator-paid path bypassed that math entirely (the user "chats on the house" and nothing flows to anyone).
- One auth path is simpler to reason about than two; eliminates the awkward "chatting on the house" UI state.
- Free-tier promo is better expressed as a welcome-credit grant on the user's org (cloud already does this — new orgs get $5 on first sync).

## Architectural trade-offs vs `apps/edad/` (character creator variant)

| concern | `edad/` (signup funnel) | `edad-chat/` (this variant) |
|---|---|---|
| where chat happens | Eliza Cloud domain (`/chat/<charId>`) | miniapp's own domain |
| character per user | yes (registered via `/api/affiliate/create-character`) | no — system prompt is per-request |
| cold-start friction | low (anon session + 5 free messages via affiliate API) | medium (OAuth sign-in required) |
| monetization lever | affiliate API `affiliateId` baked into character creation | `X-Affiliate-Code` header on every `/v1/messages` + creator markup % on the app |
| works for existing users | yes (redirects them into cloud chat) | yes (they chat right there with their credits) |
| brand continuity | breaks (user leaves miniapp domain) | preserved |

Neither is strictly better — they serve different distribution models. `edad/` wins for signup-funnel miniapps; `edad-chat/` wins for embedded chat on a branded domain.

## Deploy checklist

### Option A — embedded under a host Next.js app

1. Register app via `POST https://www.elizacloud.ai/api/v1/apps` with `{ name, app_url, skipGitHubRepo: true }` → get `app_id` back
2. (Optional) bump `inference_markup_percentage` on the app row to a value > 0 so you earn the markup share on every chat
3. Go to https://www.elizacloud.ai/dashboard/affiliates → create affiliate code, set affiliate markup %
4. Set `ELIZA_APP_ID` and `ELIZA_AFFILIATE_CODE` env vars on the host
5. Serve `public/` as static assets; wire `api/proxy.ts` as a server route at `/api/*`
6. Users hit your site → sign in with Eliza Cloud → chat → app creator earns markup; affiliate earns affiliate share; user spends their own org credits

### Option B — standalone container on Eliza Cloud

Self-hosting closes the loop: app earnings refill the org's credit balance via the earnings auto-fund service, container daily-billing keeps debiting that balance, and the app keeps itself alive as long as it earns enough.

```bash
# 1. build + push to your ECR (or any registry the cloud can pull from)
docker build -t edad-chat:latest -f apps/edad-chat/Dockerfile apps/edad-chat
docker tag edad-chat:latest <account>.dkr.ecr.<region>.amazonaws.com/edad-chat:latest
docker push <account>.dkr.ecr.<region>.amazonaws.com/edad-chat:latest

# 2. POST /api/v1/containers (use any cloud API key with deploy scope)
curl -X POST https://www.elizacloud.ai/api/v1/containers \
  -H "Authorization: Bearer $ELIZA_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "name": "edad-chat",
    "project_name": "edad",
    "port": 3000,
    "cpu": 256,
    "memory": 512,
    "ecr_image_uri": "<account>.dkr.ecr.<region>.amazonaws.com/edad-chat:latest",
    "health_check_path": "/health",
    "environment_vars": {
      "ELIZA_APP_ID": "<your-app-uuid>",
      "ELIZA_AFFILIATE_CODE": "<your-affiliate-code>",
      "ELIZA_CLOUD_URL": "https://www.elizacloud.ai"
    }
  }'

# 3. (one-time, on the org dashboard) enable earnings auto-fund:
#    PUT /api/v1/billing/earnings-auto-fund
#    { "enabled": true, "amount": 5, "threshold": 2, "keepBalance": 10 }
#    → when org credits dip below $2, auto-credit $5 from your redeemable
#      earnings, keeping at least $10 cashable at all times.
```

The container listens on `:3000`, exposes `/health` for the ECS health check, and the same `/api/*` routes as the embedded variant. No code differs between Option A and B — just the host process.

## License / attribution

Built by [RemilioNubilio](https://github.com/RemilioNubilio). Inspired by Shaw's original eDad spec in `apps/edad/`.
