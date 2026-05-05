# Building a monetized app on Eliza Cloud

End-to-end recipe: register an Eliza Cloud app, set creator markup,
forward user chat through the app-scoped endpoint, deploy as a
container, and have the container's hosting bill paid out of your
accumulated app earnings before cash credits are touched. Cashout to
elizaOS tokens whenever you want.

This is the same loop the [`edad-chat`](https://github.com/elizaOS/cloud-mini-apps/tree/main/apps/edad-chat)
reference app demonstrates. New app builds should use the app-scoped
chat endpoint, `/api/v1/apps/<appId>/chat`, so creator markup is tied
directly to the registered Cloud app.

Terminology:

- **Project**: the deployable product workspace. Containers use
  `project_name` as the stable deployment identifier.
- **App plugin**: an `@elizaos/app-*` package loaded inside Eliza.
- **Eliza Cloud app**: the Cloud app record created by `POST /api/v1/apps`;
  this is the ID used for hosting, marketplace/domain settings, chat
  routing, analytics, and monetization.

---

## The money flow at a glance

```
user chats with your app
  ↓
eliza cloud charges THE USER's org credit balance for:
  base inference cost
  + your inference markup %                  -> your redeemable_earnings
  ↓
your container daily-billing fires:
  debit your earnings up to the bill         -> spent on hosting
  fall through to your org credits if needed
  ↓
you cashout earnings to elizaOS tokens at /dashboard/earnings any time
```

The pay-as-you-go split is controlled by the organization billing
setting `payAsYouGoFromEarnings`. It is on by default: earnings pay
first, credits cover any remainder. When off, hosting comes purely from
credits and earnings stay available for token cashout.

---

## Step-by-step

### 1. Register the app

```bash
curl -X POST https://www.elizacloud.ai/api/v1/apps \
  -H "Authorization: Bearer $ELIZA_CLOUD_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "name": "MyApp",
    "app_url": "https://placeholder.invalid",
    "allowed_origins": ["https://placeholder.invalid"],
    "skipGitHubRepo": true
  }'
# -> { "success": true, "app": { "id": "<APP_ID>", ... }, "apiKey": ... }
```

Or use the SDK:

```ts
import { ElizaCloudClient } from "@elizaos/cloud-sdk";

const cloud = new ElizaCloudClient({ apiKey: process.env.ELIZA_CLOUD_API_KEY });
const { app, apiKey } = await cloud.routes.postApiV1Apps<{
  app: { id: string };
  apiKey: unknown;
}>({
  json: {
    name: "MyApp",
    app_url: "https://placeholder.invalid",
    allowed_origins: ["https://placeholder.invalid"],
    skipGitHubRepo: true,
  },
});
```

Use a placeholder URL if the container is not deployed yet. Patch
`app_url` and `allowed_origins` to the real container URL after deploy.

### 2. Set your inference markup %

The markup is the percentage you take on every app-scoped chat your
users send. At 100% markup, every dollar of inference your users pay
generates a dollar of your redeemable earnings.

Set it from the dashboard at `/dashboard/apps/<id>?tab=monetization`,
or through the API:

```bash
curl -X PUT "$ELIZA_CLOUD_BASE_URL/api/v1/apps/<APP_ID>/monetization" \
  -H "Authorization: Bearer $ELIZA_CLOUD_API_KEY" \
  -H "content-type: application/json" \
  -d '{"monetizationEnabled":true,"inferenceMarkupPercentage":100,"purchaseSharePercentage":10}'
```

Current field names are flat:

- `monetizationEnabled`: enable/disable creator earnings.
- `inferenceMarkupPercentage`: markup for inference calls, 0-1000.
- `purchaseSharePercentage`: purchase share percentage, 0-100.

### 3. (Optional) Create an affiliate code

Create an affiliate code at
[`/dashboard/affiliates`](https://www.elizacloud.ai/dashboard/affiliates)
and pass it as `X-Affiliate-Code` on implemented generic chat/message
API requests. The affiliate share lands in the code holder's redeemable
earnings on those requests, not just for users who signed up via the
code.

> **Affiliate vs. referral** — these are two different programs:
> - `X-Affiliate-Code` (header, per-request) -> affiliate markup on
>   implemented generic chat/message routes.
> - `?ref=CODE` (signup link) -> purchase referral split plus signup
>   bonus credits. It does not touch per-request app earnings. See
>   `docs/referrals.md` for that flow specifically.
>
> Same transaction never runs both — they're separate revenue streams.

Current implementation note: `POST /api/v1/apps/<appId>/chat` does not
currently read `X-Affiliate-Code`. Forwarding the header is harmless, but
affiliate earnings on app-scoped chat need product/API confirmation.

### 4. Forward chats with the app-scoped endpoint

Every user-facing chat request your app makes upstream needs the user's
Eliza Cloud bearer token:

| Header | Value |
|---|---|
| `Authorization` | `Bearer <user's Steward JWT>` |
| `X-Affiliate-Code` | Optional; implemented on generic chat/message routes, app-scoped support needs confirmation |

Hand-rolled fetch:

```ts
const res = await fetch(`${CLOUD_URL}/api/v1/apps/${APP_ID}/chat`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${userToken}`,
    ...(AFFILIATE_CODE ? { "X-Affiliate-Code": AFFILIATE_CODE } : {}),
  },
  body: JSON.stringify({ model, messages, stream: false }),
});
```

Same with the SDK (handles header composition + typed errors):

```ts
const cloud = new ElizaCloudClient({
  baseUrl: CLOUD_URL,
  bearerToken: userToken,
});
const res = await cloud.routes.postApiV1AppsByIdChatRaw({
  pathParams: { id: APP_ID },
  headers: AFFILIATE_CODE ? { "X-Affiliate-Code": AFFILIATE_CODE } : undefined,
  json: { model, messages, stream: false },
});
```

The SDK throws `CloudApiError` with `statusCode` and `errorBody` on
upstream failures. `InsufficientCreditsError` is a subclass thrown when
the user's org balance is empty. Surface a "top up your balance" message
and link them to `/dashboard/billing`.

### 5. Deploy as a container

The minute you deploy your app on Eliza Cloud's container infra, the
self-sustaining loop can kick in:

```bash
# build + push to GHCR, Docker Hub, or any registry the cloud can pull from
docker build -t myapp:latest .
docker push <registry>/myapp:latest
```

```ts
const { data: container } = await cloud.createContainer({
  name: "myapp",
  project_name: "myapp",
  port: 3000,
  cpu: 256,
  memory: 512,
  desired_count: 1,
  image: "<registry>/myapp:latest",
  health_check_path: "/health",
  environment_vars: {
    PORT: "3000",
    ELIZA_APP_ID: app.id,
    ELIZA_AFFILIATE_CODE: "<your-affiliate-code>",
    ELIZA_CLOUD_URL: "https://www.elizacloud.ai",
  },
});
```

Then patch the Cloud app with the real container URL:

```ts
await cloud.routes.patchApiV1AppsById({
  pathParams: { id: app.id },
  json: {
    app_url: container.load_balancer_url,
    allowed_origins: [container.load_balancer_url],
  },
});
```

From here on, daily container billing automatically:

1. Calculates the day's hosting cost.
2. Tries to debit it from your accumulated `redeemable_earnings` when
   `payAsYouGoFromEarnings` is enabled.
3. Falls through to `organizations.credit_balance` if earnings ran out.
4. Suspends the container only when the configured funding sources can't
   cover the bill.

### 6. Cashout

When you want to convert your earnings into elizaOS tokens, hit
`/dashboard/earnings` and click "Redeem for elizaOS". Your wallet
receives tokens on Base / Solana / Ethereum / BNB.

API cashout uses `POST /api/v1/redemptions` with `pointsAmount`,
`network`, and `payoutAddress`. `pointsAmount` is an integer where 100
points equals $1.00.

The "Already Redeemed" card on that page also shows a "Spent on hosting"
sub-line so you can see how much of your earnings the container loop has
consumed vs how much you've withdrawn.

---

## Where the SDK fits in

`@elizaos/cloud-sdk` is the typed binding to every public Eliza Cloud
endpoint. You get:

- High-level helpers for the common stuff (`createChatCompletion`,
  `createContainer`, `getCreditsBalance`, ...).
- Typed `cloud.routes.*` for everything the helpers don't cover yet.
- Per-request bearer tokens, sticky default headers, automatic JSON
  parsing, typed errors.

For a complete worked example see
[`apps/edad-chat/server.ts`](https://github.com/elizaOS/cloud-mini-apps/blob/main/apps/edad-chat/server.ts)
in the cloud-mini-apps repo.

---

## Where to look in the codebase

| Concern | File |
|---|---|
| App registration | `apps/api/v1/apps/route.ts` |
| App update | `apps/api/v1/apps/[id]/route.ts` |
| Monetization settings | `apps/api/v1/apps/[id]/monetization/route.ts` |
| App-scoped chat | `apps/api/v1/apps/[id]/chat/route.ts` |
| Affiliate code creation + lookup | `packages/lib/services/affiliates.ts` |
| Per-chat earnings ledger entry | `packages/lib/services/redeemable-earnings.ts` |
| Container daily billing | `apps/api/cron/container-billing/route.ts` |
| Earnings -> org credits conversion | `RedeemableEarningsService.convertToCredits` |
| Token redemption / cashout | `apps/api/v1/redemptions/*` |
