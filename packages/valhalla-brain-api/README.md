# Valhalla Brain API

A read-only signal API. It does not trade and it does not send funds. Scores are informational. They are not financial advice and they do not promise profit.

## Endpoints

- `GET /v1/health`
- `GET /v1/score/:mint`
- `POST /v1/score/batch`
- `GET /v1/wallet/:pubkey/summary`
- `GET /v1/trending`
- `GET /v1/usage`

Send `Authorization: Bearer <api key>`. The worker stores only the SHA-256 hash of a key. Free keys allow 100 calls a day. Dev keys allow 5,000. Pro keys allow 100,000. `GET /v1/usage` does not count toward the limit.

A signed `POST /v1/billing/lemon` can set a hash to the Pro plan when Lemon Squeezy reports an active subscription. Put the hash in `meta.custom_data.api_key_hash`. Set the signing secret with `npx wrangler secret put LEMONSQUEEZY_SIGNING_SECRET`. The route does nothing until that secret exists.

## curl

```bash
curl -s https://YOUR-WORKER.workers.dev/v1/health
curl -s -H "Authorization: Bearer $VALHALLA_BRAIN_KEY" \
  https://YOUR-WORKER.workers.dev/v1/score/So11111111111111111111111111111111111111112
```

## Add a hashed key

```bash
printf '%s' "$VALHALLA_BRAIN_KEY" | sha256sum
```

Then, after D1 exists:

```sql
INSERT INTO api_keys (key_hash, plan, created_at)
VALUES ('<64 hex chars>', 'free', datetime('now'));
```

You can also set the secret `BRAIN_KEYS` to lines of `hash:free`. A raw key in that secret is ignored.

## Pro portal

The worker serves the portal at `/app`. Sign-in is a Solana login message or Google. The session is an HttpOnly cookie. Set `SESSION_SECRET` before login works. Set `GOOGLE_CLIENT_ID` for Google. Set `ADMIN_EMAILS` to the operator Google emails. Do not commit those values.

The public page is https://valhalla-app.xyz/app. The intended host is https://app.valhalla-app.xyz after a CNAME to this worker. TODO: TJ creates the free Cloudflare project and that DNS record.

## Deploy for $0

TODO: TJ creates a free Cloudflare account.

```bash
cd packages/valhalla-brain-api
npx wrangler login
npx wrangler d1 create valhalla-brain
npx wrangler kv namespace create VALHALLA_KV
```

Paste the ids into `wrangler.toml`. Then:

```bash
npx wrangler secret put HELIUS_API_KEY
npx wrangler secret put BIRDEYE_API_KEY
npx wrangler deploy
```

Do not commit those secrets.

The OpenAPI file is `openapi.yaml`. The TypeScript client is `@valhalla/brain-sdk`.
