# eDad Chat — the dad you never had

This example **keeps the chat UI on the app's own domain** and proxies `/api/v1/messages` calls to Eliza Cloud with the app + affiliate code attached as headers (`x-app-id`, `x-affiliate-code`).

Shipped live at **https://eliza.nubs.site/apps/edad/** by RemilioNubilio.

## Why this pattern exists

- Keeps users on the miniapp's domain end-to-end (branding, UX continuity, embeddable elsewhere)
- Users sign in with Eliza Cloud once; the app gets their **identity** (not a Cloud token) and mints its own session
- App creator earns the inference markup % on every reply; the affiliate code adds a separate share
- No character registration, no anonymous session management — lean proxy + minimal frontend

## Auth & billing model (read this)

Eliza Cloud's app OAuth returns a **single-use authorization code** (`eac_…`) on the
redirect — never a durable user token. By design a third-party app can learn a
user's *identity* but cannot hold their Cloud JWT. So this app:

1. redeems the code **once, server-side**, at `GET /api/v1/app-auth/session` to get the user's identity, then
2. mints its **own** signed session token (`app-session.ts`) the browser reuses, and
3. proxies `/api/v1/messages` using the **app owner's** `ELIZAOS_CLOUD_API_KEY` (server-side only) plus `x-app-id` + `x-affiliate-code`.

Because the call carries `x-app-id` for a monetization-enabled app, Cloud bills
the app's **monetized credit pool** with the creator inference markup and credits
the affiliate — the owner key never reaches the browser, and the single-use code
is never reused.

```
browser                                  app backend                          eliza cloud
┌──────────────────┐  POST /api/auth/    ┌──────────────────┐  GET /app-auth/   ┌───────────────────┐
│ ?code=eac_… ─────┼─── exchange ───────▶│ redeem code →    │── session ───────▶│ consume code →    │
│ (single-use)     │                     │ identity, mint   │   (Bearer code)   │ return identity   │
│                  │                     │ app session      │◀──────────────────│                   │
│ x-app-session ───┼── POST /api/messages▶│ owner key +      │  /api/v1/messages │ app-pool billing  │
│ (our token)      │                     │ x-app-id + aff.  │── (owner bearer) ─▶│ + markup → creator│
└──────────────────┘                     └──────────────────┘                   │ + affiliate share │
                                                                                 └───────────────────┘
```

> Note: a "user pays from their **own** org balance" variant would require the
> app to present the user's Steward JWT, which the app-OAuth code flow
> deliberately does not hand out. This template uses the supported app-credit-pool
> path above. The full live OAuth round-trip needs a deployed app + a real Cloud
> sign-in to exercise end to end; the session logic and auth gating are covered by
> `test.ts`.

## Files

| file | purpose |
|---|---|
| `public/index.html` | landing + chat UI + OAuth sign-in + message loop |
| `public/style.css` | dad-energy dark theme, SVG silhouette, responsive |
| `public/meta.json` | app index metadata |
| `server.ts` | standalone Bun server: serves `public/`, exposes `GET /api/config`, `POST /api/messages` (forwards to `/api/v1/messages` via @elizaos/cloud-sdk with `x-app-id`/`x-affiliate-code`), `GET /api/history` (per-user persisted chat, when a DB is present), and `/health` |
| `db.ts` | optional per-tenant Postgres persistence via native `Bun.sql` — saves each turn + serves history. No-op without `DATABASE_URL`, so the proxy still runs standalone |
| `Dockerfile` | bun:1.2-alpine image, exposes :3000, includes `/health` for ECS health checks |

## Env required

```bash
ELIZA_APP_ID=<uuid of app registered via POST /api/v1/apps>
ELIZAOS_CLOUD_API_KEY=eliza_...     # the app OWNER's Cloud key — the server's upstream bearer (never sent to the browser)
ELIZA_CLOUD_URL=https://www.elizacloud.ai
ELIZA_AFFILIATE_CODE=AFF-XXXXXX     # your affiliate code — drives per-call affiliate share earnings
EDAD_SESSION_SECRET=<random>        # OPTIONAL — signs app session tokens; defaults to ELIZAOS_CLOUD_API_KEY
DATABASE_URL=postgres://...         # OPTIONAL — when set, chat history persists (see below)
```

### Per-tenant database (optional)

Deploy edad on Eliza Cloud with `databaseMode: "isolated"` and the platform
provisions an isolated Postgres DB + injects `DATABASE_URL` (reachable only via
the per-app DB ambassador — no other tenant can connect, no general egress).
`db.ts` then persists each turn so a signed-in user's history survives across
sessions, and `GET /api/history` serves it back. Without `DATABASE_URL` it's a
silent no-op — the proxy runs stateless anywhere. This makes edad a single app
that exercises the **whole** platform: monetized inference + container deploy +
per-tenant DB + per-app auth + custom domain.

There is **no anonymous fallback**. The proxy rejects requests without a valid app session with 401 — users must sign in with Eliza Cloud first. Reasoning:

- The whole point of monetization is that creators + affiliates earn a real cut of every billed reply. An anonymous path bypassed that math entirely (the user "chats on the house" and nothing is attributed to anyone).
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
| existing users | chat right there after a one-click sign-in |
| brand continuity | preserved (users never leave the app's domain) |

A signup-funnel pattern trades brand continuity for lower cold-start friction
(anonymous sessions, free intro messages); chat-in-place keeps users on a
branded domain and bills the app's monetized credit pool from the first message.

## Deploy checklist

### Option A — embedded under a host Next.js app

1. Register app via `POST https://www.elizacloud.ai/api/v1/apps` with `{ name, app_url, skipGitHubRepo: true }` → get `app_id` back
2. (Optional) bump `inference_markup_percentage` on the app row to a value > 0 so you earn the markup share on every chat
3. Go to https://www.elizacloud.ai/dashboard/affiliates → create affiliate code, set affiliate markup %
4. Set `ELIZA_APP_ID`, `ELIZAOS_CLOUD_API_KEY`, and `ELIZA_AFFILIATE_CODE` env vars on the host
5. Run the bundled Bun server (`bun run server.ts`); it serves `public/` and the `/api/*` routes itself (no separate route handler to mount)
6. Users hit your site → sign in with Eliza Cloud → chat → app creator earns markup; affiliate earns affiliate share; billing hits the app's monetized credit pool

### Option B — standalone container on Eliza Cloud

Self-hosting closes the loop: container daily-billing debits the owner's redeemable app earnings **before** org credits (the org's `payAsYouGoFromEarnings` toggle, on by default), so the app keeps itself alive as long as it earns enough.

<!-- The plain ./Dockerfile cannot be built standalone: server.ts imports the
     `@elizaos/cloud-sdk` workspace dep, which only resolves inside the monorepo.
     Bundle the SDK in first (what CI does), then ship the tiny bundle context
     with Dockerfile.bundle. The reproducible showcase image is built+smoke-tested
     by .github/workflows/build-example-app-images.yml and published as
     ghcr.io/elizaos/example-edad:showcase. The #9300 real-staging showcase
     validation uses Dockerfile.cloud through the normal source-build app deploy
     path instead of pinning that image operator-side — see
     packages/test/cloud-e2e/docs/showcase-apps-coverage.md for the full runbook. -->

```bash
# 1. bundle the server (inlines the workspace SDK), then build + push the image
cd packages/examples/cloud/edad
bun build server.ts --outdir=dist --target=bun --format=esm && cp -r public dist/public
docker build -t edad-chat:latest -f Dockerfile.bundle dist
# push to any registry the cloud can pull from (GHCR is what the showcase uses)
docker tag edad-chat:latest ghcr.io/<owner>/edad-chat:latest
docker push ghcr.io/<owner>/edad-chat:latest

# 2. POST /api/v1/containers (use any cloud API key with deploy scope)
#    Body keys are camelCase — CreateContainerSchema
#    (packages/cloud/api/v1/containers/schema.ts) strips unknown keys, so a
#    snake_case body (project_name, environment_vars, …) deploys a container
#    with NO env vars → dead sign-in + billing. Pass the cloud key as
#    ELIZA_CLOUD_API_KEY: ELIZAOS_CLOUD_API_KEY is a platform-reserved env key
#    this route rejects (#9853), and server.ts reads both names.
curl -X POST https://www.elizacloud.ai/api/v1/containers \
  -H "Authorization: Bearer $ELIZA_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "name": "edad-chat",
    "projectName": "edad",
    "port": 3000,
    "cpu": 256,
    "memoryMb": 512,
    "image": "ghcr.io/<owner>/edad-chat:latest",
    "healthCheckPath": "/health",
    "environmentVars": {
      "ELIZA_APP_ID": "<your-app-uuid>",
      "ELIZA_CLOUD_API_KEY": "<your-cloud-key>",
      "ELIZA_AFFILIATE_CODE": "<your-affiliate-code>",
      "ELIZA_CLOUD_URL": "https://www.elizacloud.ai"
    }
  }'

# 3. self-funding is ON by default: the container-billing cron pays each
#    day's container charge from the owner's redeemable app earnings first,
#    then org credits (org toggle `payAsYouGoFromEarnings`, default true).
#    To keep earnings cashable instead and bill credits only:
#    PUT /api/v1/billing/settings  { "payAsYouGoFromEarnings": false }
```

The container listens on `:3000`, exposes `/health` for the ECS health check, and the same `/api/*` routes as the embedded variant. No code differs between Option A and B — just the host process.

## License / attribution

Built by [RemilioNubilio](https://github.com/RemilioNubilio).
