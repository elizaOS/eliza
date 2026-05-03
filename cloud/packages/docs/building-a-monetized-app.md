# Building a monetized app on Eliza Cloud

End-to-end recipe: register an app, set markup, optionally take an
affiliate cut, deploy as a container, and have the container's hosting
bill paid out of your accumulated app earnings before any cash credits
get touched. Cashout to elizaOS tokens whenever you want.

This is the same loop the [`edad-chat`](https://github.com/elizaOS/cloud-mini-apps/tree/main/apps/edad-chat) reference app demonstrates.

---

## The money flow at a glance

```
user chats with your app
  ↓
eliza cloud charges THE USER's org credit balance for:
  base inference cost
  + your inference markup %                  → your redeemable_earnings
  + (optional) affiliate %                   → affiliate's redeemable_earnings
  ↓
your container daily-billing fires:
  debit your earnings up to the bill         → spent on hosting (free!)
  fall through to your org credits if needed
  ↓
you cashout earnings to elizaOS tokens at /dashboard/earnings any time
```

The pay-as-you-go split is automatic — no config, no settings, no
toggle. Earnings always pay first, credits cover any remainder.

---

## Step-by-step

### 1. Register the app

```bash
curl -X POST https://www.elizacloud.ai/api/v1/apps \
  -H "Authorization: Bearer $ELIZA_CLOUD_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "name": "MyApp",
    "app_url": "https://my.app",
    "skipGitHubRepo": true
  }'
# → { "id": "<APP_ID>", ... }
```

Or use the SDK:

```ts
import { ElizaCloudClient } from "@elizaos/cloud-sdk";

const cloud = new ElizaCloudClient({ apiKey: process.env.ELIZA_CLOUD_API_KEY });
const app = await cloud.routes.postApiV1Apps({
  json: { name: "MyApp", app_url: "https://my.app", skipGitHubRepo: true },
});
```

### 2. Set your inference markup %

The markup is the percentage you take on every chat your users send.
At 100% markup, every dollar of inference your users pay generates a
dollar of your redeemable earnings.

Set it from the dashboard at `/dashboard/apps/<id>?tab=monetization`,
or directly:

```sql
UPDATE apps
   SET monetization_enabled = true,
       inference_markup_percentage = 100
 WHERE id = '<APP_ID>';
```

### 3. (Optional) Create an affiliate code

Create an affiliate code at
[`/dashboard/affiliates`](https://www.elizacloud.ai/dashboard/affiliates)
and pass it as `x-affiliate-code` on every request. The affiliate share
lands in the code holder's redeemable earnings on **every chat**, not
just for users who signed up via the code — works for new and existing
users alike (see `packages/lib/services/ai-billing.ts:192,277`).

> **Affiliate vs. referral** — these are two different programs:
> - `x-affiliate-code` (header, per-request) → markup % on every chat,
>   regardless of who the user is. This is what edad-chat uses.
> - `?ref=CODE` (signup link) → 50/40/10 split on the new user's
>   *purchases* (Stripe / x402) plus signup bonus credits. Doesn't
>   touch per-request earnings. See `docs/referrals.md` for that
>   flow specifically.
>
> Same transaction never runs both — they're separate revenue streams.

### 4. Forward chats with the right headers

Every `/api/v1/messages` request your app makes upstream needs:

| Header | Value |
|---|---|
| `Authorization` | `Bearer <user's Steward JWT>` |
| `x-app-id` | your app's `id` from step 1 |
| `x-affiliate-code` | (optional) the affiliate code from step 3 |
| `anthropic-version` | `2023-06-01` |

Hand-rolled fetch:

```ts
const res = await fetch(`${CLOUD_URL}/api/v1/messages`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${userToken}`,
    "x-app-id": APP_ID,
    "x-affiliate-code": AFFILIATE_CODE,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({ model, max_tokens, system, messages }),
});
```

Same with the SDK (handles header composition + typed errors):

```ts
const cloud = new ElizaCloudClient({
  baseUrl: CLOUD_URL,
  bearerToken: userToken,
  defaultHeaders: {
    "x-app-id": APP_ID,
    "x-affiliate-code": AFFILIATE_CODE,
    "anthropic-version": "2023-06-01",
  },
});
const reply = await cloud.routes.postApiV1Messages({
  json: { model, max_tokens, system, messages },
});
```

The SDK throws `CloudApiError` (with `statusCode` + `errorBody`) on
upstream failures. `InsufficientCreditsError` is a subclass thrown when
the user's org balance is empty — surface a "top up your balance"
message and link them to `/dashboard/billing`.

### 5. Deploy as a container

The minute you deploy your app on Eliza Cloud's container infra, the
self-sustaining loop kicks in:

```bash
# build + push to your registry (ECR or any registry the cloud can pull from)
docker build -t myapp:latest .
docker push <registry>/myapp:latest

# deploy via the SDK
const container = await cloud.createContainer({
  name: "myapp",
  project_name: "myapp",
  port: 3000,
  cpu: 256,
  memory: 512,
  ecr_image_uri: "<registry>/myapp:latest",
  health_check_path: "/health",
  environment_vars: {
    ELIZA_APP_ID: app.id,
    ELIZA_AFFILIATE_CODE: "<your-affiliate-code>",
    ELIZA_CLOUD_URL: "https://www.elizacloud.ai",
  },
});
```

From here on, daily container billing automatically:

1. Calculates the day's hosting cost (CPU + memory * hourly rate)
2. Tries to debit it from your accumulated `redeemable_earnings`
3. Falls through to `organizations.credit_balance` if earnings ran out
4. Suspends the container only when **both** pools can't cover the bill

That's the full loop. No knobs to turn.

### 6. Cashout

When you want to convert your earned credits into elizaOS tokens, hit
`/dashboard/earnings` and click "Redeem for elizaOS". Your wallet
receives tokens on Base / Solana / Ethereum / BNB.

The "Already Redeemed" card on that page also shows a **"Spent on hosting"** sub-line so you can see, at a glance, how much of your earnings the container loop has consumed vs how much you've withdrawn.

---

## Where the SDK fits in

`@elizaos/cloud-sdk` is the typed binding to every public Eliza Cloud
endpoint. You get:

- High-level helpers for the common stuff (`createChatCompletion`,
  `createContainer`, `getCreditsBalance`, ...)
- Typed `cloud.routes.*` for everything the helpers don't cover yet —
  generated from the Next.js route tree, so coverage stays in sync
- Per-request bearer tokens, sticky default headers, automatic JSON
  parsing, typed errors

For a complete worked example see
[`apps/edad-chat/server.ts`](https://github.com/elizaOS/cloud-mini-apps/blob/main/apps/edad-chat/server.ts)
in the cloud-mini-apps repo.

---

## Where to look in the codebase

| Concern | File |
|---|---|
| App registration + markup config | `app/api/v1/apps/route.ts`, `app/api/v1/apps/[id]/route.ts` |
| Affiliate code creation + lookup | `packages/lib/services/affiliates.ts` |
| Per-chat earnings ledger entry | `packages/lib/services/redeemable-earnings.ts` |
| Container daily billing (the pay-as-you-go split) | `app/api/cron/container-billing/route.ts` |
| Earnings → org credits conversion | `RedeemableEarningsService.convertToCredits` |
| Token redemption / cashout | `app/api/v1/redemptions/*` |
