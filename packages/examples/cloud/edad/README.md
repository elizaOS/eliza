# eDad Chat — the dad you never had

This example **keeps the chat UI on the app's own domain** and proxies `/api/v1/messages` calls to Eliza Cloud with the app + affiliate code attached as headers (`x-app-id`, `x-affiliate-code`).

Shipped live at **https://eliza.nubs.site/apps/edad/** by RemilioNubilio.

## Why this pattern exists

- Keeps users on the miniapp's domain end-to-end (branding, UX continuity, embeddable elsewhere)
- Users sign in to Eliza Cloud once and chat with their own org credit balance — no per-app credit pool to top up
- App creator earns the inference markup % on every reply via `recordCreatorEarnings`; affiliate code adds a separate share
- No character registration, no anonymous session management — lean proxy + minimal frontend

## How it works

```
browser                                  app backend                         eliza cloud
┌──────────────────┐                    ┌──────────────────┐                ┌───────────────────┐
│ index.html       │ POST /api/messages │ server.ts        │ /api/v1/messages│ debits user's    │
│ + chat UI JS     │───────────────────▶│ adds x-app-id    │───────────────▶│ org balance      │
│                  │                    │ + x-affiliate-   │                │ adds markup → me │
│ Steward JWT      │                    │   code header    │                │ creator earnings │
│ (OAuth required) │                    │ + Authorization  │                │ + affiliate share│
└──────────────────┘                    └──────────────────┘                └───────────────────┘
```

## Files

| file | purpose |
|---|---|
| `public/index.html` | landing + chat UI + OAuth sign-in + message loop |
| `public/style.css` | dad-energy dark theme, SVG silhouette, responsive |
| `public/meta.json` | app index metadata |
| `server.ts` | standalone Bun server: serves `public/`, exposes `GET /api/config`, `POST /api/messages` (forwards to `/api/v1/messages` via @elizaos/cloud-sdk with `x-app-id`/`x-affiliate-code`), and `/health` |
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

## Design note: chat-in-place vs a signup-funnel pattern

This example is a **chat-in-place** app: the chat UI stays on the app's own
domain and the backend proxies straight to Eliza Cloud. An alternative
**signup-funnel** pattern would instead register a per-user character on Eliza
Cloud and redirect users into cloud-hosted chat. The trade-offs of the
chat-in-place approach used here:

| concern | chat-in-place (this example) |
|---|---|
| where chat happens | the app's own domain |
| per-user character | no — the system prompt is sent per request |
| cold-start friction | medium (OAuth sign-in required up front) |
| monetization lever | `X-Affiliate-Code` header on every `/api/v1/messages` + creator markup % on the app |
| existing users | chat right there with their own org credits |
| brand continuity | preserved (users never leave the app's domain) |

A signup-funnel pattern trades brand continuity for lower cold-start friction
(anonymous sessions, free intro messages); chat-in-place keeps users on a
branded domain and bills their own org credits from the first message.

## Deploy checklist

### Option A — embedded under a host Next.js app

1. Register app via `POST https://www.elizacloud.ai/api/v1/apps` with `{ name, app_url, skipGitHubRepo: true }` → get `app_id` back
2. (Optional) bump `inference_markup_percentage` on the app row to a value > 0 so you earn the markup share on every chat
3. Go to https://www.elizacloud.ai/dashboard/affiliates → create affiliate code, set affiliate markup %
4. Set `ELIZA_APP_ID` and `ELIZA_AFFILIATE_CODE` env vars on the host
5. Run the bundled Bun server (`bun run server.ts`); it serves `public/` and the `/api/*` routes itself (no separate route handler to mount)
6. Users hit your site → sign in with Eliza Cloud → chat → app creator earns markup; affiliate earns affiliate share; user spends their own org credits

### Option B — standalone container on Eliza Cloud

Self-hosting closes the loop: app earnings refill the org's credit balance via the earnings auto-fund service, container daily-billing keeps debiting that balance, and the app keeps itself alive as long as it earns enough.

```bash
# 1. build + push to your ECR (or any registry the cloud can pull from)
docker build -t edad-chat:latest -f packages/examples/cloud/edad/Dockerfile packages/examples/cloud/edad
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

Built by [RemilioNubilio](https://github.com/RemilioNubilio).
