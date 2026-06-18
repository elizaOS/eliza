# PayPerPixel — pay-per-image over x402

A standalone image-generation app where the **end user pays in USDC over the
[x402](https://www.x402.org/) protocol** — no Eliza Cloud account, no credit
top-up, just a wallet. Each settled crypto payment is credited to the app
creator's Eliza Cloud earnings, which they can redeem for elizaOS tokens.

This is the third Eliza Cloud example app, alongside [`edad`](../edad)
(chat-in-place, billed to the user's org credits) and
[`clone-ur-crush`](../clone-ur-crush) (signup-funnel). It is the canonical
reference for **charging crypto per action** instead of per-account credits.

## Why this pattern exists

- **No account friction.** The buyer never signs up for Eliza Cloud — they pay
  per image with a wallet. Ideal for one-off, viral, or anonymous use.
- **Crypto in, tokens out.** The x402 payment settles on-chain to the platform
  recipient and is credited to the creator's `redeemable_earnings`. The creator
  redeems for elizaOS tokens from the Cloud dashboard (Earnings → Redeem).
- **Earnings are real and tracked.** Settling a payment request that carries an
  `appId` fires `recordAppScopedPaymentEarnings` upstream: it writes
  `app_earnings`, an `app_earnings_transactions` row, the `apps` rollup, and the
  creator's redeemable balance — deduped by payment id.

## How it works

The `/api/generate` endpoint implements the standard x402 "retry with payment"
handshake:

```
browser                              app backend (server.ts)            eliza cloud
┌────────────────┐  POST /generate   ┌──────────────────────┐  POST /x402/requests ┌──────────────────┐
│ prompt         │──────────────────▶│ create x402 request  │─────────────────────▶│ durable request  │
│                │◀── 402 + accepts ──│ (bound to appId)     │◀── paymentRequired ──│ payTo, amount    │
│ wallet pays ───┼──────────────┐    │                      │                      │                  │
│ + settles      │              ▼    │                      │  POST .../settle     │ settle on-chain  │
│                │  POST /generate    │ settle then generate │─────────────────────▶│ → creator earns  │
│                │  {payload}        │                      │  POST /generate-image│ → image (owner   │
│ ◀───── image ──┼───────────────────│                      │◀─────── image ───────│   org credits)   │
└────────────────┘                   └──────────────────────┘                      └──────────────────┘
```

The buyer pays the x402 charge; the image itself is generated with the **app
owner's** Cloud credits, funded over time by those same earnings (the
"survival economics" loop — see the `build-monetized-app` skill).

## Files

| file | purpose |
|---|---|
| `server.ts` | standalone Bun server: serves `public/`, `GET /api/config`, `POST /api/generate` (x402 quote → settle → image), `GET /api/earnings`, `/health` |
| `public/index.html` · `style.css` · `app.js` | prompt → pay → image UI + live creator-earnings panel |
| `test.ts` | local flow test — boots a mock Eliza Cloud + the app server and drives quote → settle → generate → earnings → idempotency |
| `Dockerfile` | `oven/bun` image, `:3000`, `/health` probe |

## Env

```bash
ELIZAOS_CLOUD_API_KEY=eliza_...        # app owner's Cloud API key (creates requests, generates images)
ELIZA_APP_ID=<uuid>                    # registered app id — binds x402 earnings to the creator
ELIZA_CLOUD_URL=https://www.elizacloud.ai
X402_NETWORK=base                      # base | base-sepolia | ethereum | bsc | solana ...
X402_PRICE_USD=0.05                    # price per image
X402_IMAGE_MODEL=                      # optional model override (default: cloud image provider)
PORT=3000
```

Register the app first to get `ELIZA_APP_ID` (and an API key):

```bash
curl -X POST https://www.elizacloud.ai/api/v1/apps \
  -H "Authorization: Bearer $ELIZAOS_CLOUD_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"PayPerPixel","app_url":"https://payperpixel.example"}'
```

## Run

```bash
bun install                      # from the repo root (links @elizaos/cloud-sdk)
cd packages/examples/cloud/x402-image-gen
ELIZAOS_CLOUD_API_KEY=eliza_... ELIZA_APP_ID=<uuid> bun run start
# open http://localhost:3000
```

## Test

```bash
bun run test     # local flow test against a mock cloud — no crypto, no live cloud
```

The automated test validates the server's orchestration end-to-end. **Live
payment is intentionally not automated**: settling a real x402 request requires a
funded wallet on the chosen network. The UI shows the exact x402 challenge
(amount, network, `payTo`, request id); a wallet integration (e.g.
[`x402-fetch`](https://www.npmjs.com/package/x402-fetch)) signs and settles it,
then re-POSTs `/api/generate` with the settled payload to receive the image. The
UI's payload textarea lets you paste a settled payload manually for live testing.

## Deploy as a container

Swap `"@elizaos/cloud-sdk": "workspace:*"` in `package.json` for a published
version, then build and deploy via the Cloud container flow (see the
`build-monetized-app` skill, or `POST /api/v1/containers`). Set the env above as
container secrets.
