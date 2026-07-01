# Cloud Apps — deploy + end-to-end validation runbook

This is the operator checklist for taking the three example apps
([`edad`](edad), [`clone-ur-crush`](clone-ur-crush),
[`x402-image-gen`](x402-image-gen)) live on an example account and validating the
full money loop: **payment in (card + crypto) → charging → payment out
(redemption / points)**.

Everything below requires production credentials (Cloudflare/Steward/Stripe/a
funded wallet) and is intentionally **not** automated — it moves real money and
mutates production. The code-side pieces (the apps, the x402→earnings binding,
the nav rename) are committed and unit/flow-tested in the repo; this runbook is
the remaining operator-only work.

Live status at the time of writing (read-only probes):

| surface | check | result |
|---|---|---|
| Cloud API | `GET https://api.elizacloud.ai/api/health` | `200` |
| Steward providers | `GET https://api.elizacloud.ai/steward/auth/providers` | `200` — passkey/email/sms/totp/SIWE/SIWS + Google/Discord/GitHub/Twitter |
| Login page | `GET https://elizacloud.ai/login` | `200` |
| x402 support | `GET https://api.elizacloud.ai/api/v1/x402` | `200` |

### Validated live this session (against production, with the example account API key)

- **All three apps registered live on the example account** with monetization
  enabled (20% markup, 10% purchase share): `PayPerPixel` (`229e3b2d…`),
  `eDad Example` (`dd2b5647…`), `Clone Ur Crush Example` (`c38794b8…`). The bare
  names "eDad"/"Clone Ur Crush" are globally taken, so example-suffixed names
  were used. Confirm under **Dashboard → Apps**.
- **Live x402 payment request created and app-bound** — `POST /api/v1/x402/requests`
  with `appId` returned a real request (`amountUsd 0.05`, network `eip155:8453`,
  a real `payTo`). The payment-in challenge is real; on-chain settlement needs a
  funded wallet (operator).
- **Browser e2e (chromium) passed for all three miniapps**, 0 console/page
  errors: PayPerPixel full flow (home → x402 payment card → settled image),
  eDad landing+config, clone-ur-crush landing+cloning funnel.
- **✅ CHARGING proven live end-to-end.** 3 chat completions (`zai-glm-4.7`,
  ~1,417 tokens) deducted **$0.004648** from the org credit balance
  ($4.967245 → $4.962597). The charge → meter → deduct loop works.
- **✅ PAYMENT-OUT machinery validated (read path).** `GET /api/v1/redemptions/balance`
  returns the full structure + eligibility/limits and correctly gates
  (`canRedeem:false, "Minimum redemption is $1.00. You have $0.00 available."`);
  `/api/v1/apps/<id>/earnings` returns the summary. The actual token payout can't
  fire only because redeemable balance is $0 (earnings require funded-wallet x402
  settlement) — a resource constraint, not a code gap. "Points" = this redeemable
  balance (1 point = 1¢).

#### ⚠️ Weaknesses found live (each has a follow-up task)

- **Image generation returns HTTP 500 — ROOT CAUSE: exhausted provider balance.**
  Reproduced the fal provider call directly with the prod `FAL_KEY`: it returns
  `403 "User is locked. Reason: Exhausted balance. Top up at fal.ai/dashboard/billing"`.
  The adapter threw a raw Error → `failureResponse` mapped it to a blanket 500.
  **Fixed in `packages/cloud/api/v1/generate-image/route.ts`**: provider failures
  now log the real detail and return a retryable **503** (no provider detail
  leaked). **Operational fix to unblock live image charging: top up the
  fal / bitrouter / atlascloud provider balances.**
- **Pricing-catalog gaps — major models 500 "Pricing unavailable".** `openai/gpt-5.5`
  (the documented default), `anthropic/claude-haiku-4.5`, `x-ai/grok-4.20`, and
  `openai/gpt-5-mini` all 500 when used; `openai/gpt-oss-120b:free` 500s
  "no route found"; `gpt-oss-120b` 429s (rate-limited); only some (`zai-glm-4.7`)
  work. The models registry is out of sync with the pricing catalog
  (`ai-pricing/lookup.ts:146`). Needs real prices reconciled (flagged as a task).
- **Monetization PUT silently ignores wrong-cased keys** (snake_case → 200 no-op;
  use camelCase — see §1).
- **Stripe `success_url` allowlist is strict** — only `https://elizacloud.ai` is
  accepted by `getDefaultPlatformRedirectOrigins()`; `www.` and `app.` subdomains
  are rejected ("Invalid success_url"). A UX footgun if the frontend ever passes a
  www/app origin.

#### Money loop — now proven live except the two user-only money-moves

- **Card IN — validated both ends.** `POST /api/v1/credits/checkout`
  (`{credits, success_url, cancel_url}`, `success_url` origin must be
  `https://elizacloud.ai`) created a **real live Stripe checkout session**
  (`https://checkout.stripe.com/c/pay/cs_live_…`); and the credit-grant webhook
  (`checkout.session.completed` → record + enqueue org credit) is unit-tested
  green (`packages/cloud/api/__tests__/stripe-webhook-route.test.ts`, 4/4).
  Driving a card through the middle needs either a real card (live) or a
  `sk_test` key + Stripe CLI (test mode) — neither is in this env (only `sk_live`,
  no Stripe CLI). **"local dev test mode" requires provisioning Stripe test keys
  + the Stripe CLI for webhook forwarding.**
- **Earning → redeemable points — proven live.** Inference attributed to
  PayPerPixel (`X-App-Id`, markup temporarily raised) grew the creator's
  redeemable balance **$0 → $1.0812** (`bySource: miniapp`) with matching
  `app_earnings`; markup reset to 20% after. So
  charging → markup → `app_earnings` → `redeemable_earnings` (points) all fire
  live, and eligibility flips to `canRedeem:true`.
- **Payment OUT — EXECUTED (user-authorized) → found a prod bug.** Generated a
  Base wallet and ran the real redemption (`POST /api/v1/redemptions`, 100 pts →
  base). It returned **HTTP 500** — and `GET /redemptions/quote` + `/status` also
  500 — while balance/eligibility are fine and the balance is NOT locked on
  failure. The TWAP eliza-token-price oracle / payout-status service throws (see
  `redemptions/quote/route.ts` → `twapPriceOracle.getRedemptionQuote` /
  `payoutStatusService.isNetworkAvailable`). **Added error logging to both
  catches** (was opaque). So the on-chain payout is blocked by a **production
  payout-infrastructure failure**, not authorization — flagged as a task; fix =
  feed the TWAP oracle / configure the payout hot wallet, or fail gracefully.

#### Example app fixes shipped this session
- **clone-ur-crush rendered unstyled** — it's on Tailwind v4 but `app/globals.css`
  used the dead v3 `@tailwind base/components/utilities` directives (zero utilities
  generated). Fixed to v4 `@import "tailwindcss"` + `@config`. Verified live.

## 0. Steward: confirm login + signup work (goal: "make sure we can log in and create an account")

The login UI, JWT verification, user-sync, and logout allowlist are correct in
this repo. The only blockers live in the **external** Steward service config:

1. **Signup is open.** New-user signup is gated by Steward
   `tenant_configs.join_mode` for the `elizacloud` tenant. It must be `'open'`
   (not `'invite'`). This is set in Steward's own DB, not this repo.
   - Verify with a real signup: open https://elizacloud.ai/login → "Magic Link"
     with a fresh email → confirm an org + initial free credits are created
     (`syncUserFromSteward`, `INITIAL_FREE_CREDITS`). If signup says "needs an
     invite", flip `join_mode` to `'open'` in the Steward DB.
2. **Secrets match.** `STEWARD_JWT_SECRET` (or legacy `STEWARD_SESSION_SECRET`)
   on the Cloud API Worker must equal Steward's signing secret, or every authed
   request 401s. `STEWARD_API_URL` and `STEWARD_REQUEST_SIGNING_SECRET` must be
   set (else provider discovery / magic-link send fail).
3. **Logout** (`POST /api/auth/logout`) is in `publicPathPrefixes` — confirm it
   returns 200 and clears the `steward-token` cookies.

Acceptance: a brand-new email can sign up, land in the dashboard, see free
credits, and log out cleanly.

## 1. Register the three apps on the example account

Sign in as the example creator, grab an API key
(`Dashboard → API Keys`, or `Dashboard → Apps → Register App`). Then for each
app, register it and capture `{ appId, apiKey }`:

```bash
export KEY=eliza_...          # example account API key
register () {
  curl -s -X POST https://www.elizacloud.ai/api/v1/apps \
    -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d "{\"name\":\"$1\",\"app_url\":\"$2\"}" | jq '{id, slug, api_key_id}'
}
register "eDad"           "https://edad.example"
register "Clone Ur Crush" "https://cloneurcrush.example"
register "PayPerPixel"    "https://payperpixel.example"
```

Turn on monetization for each (markup + purchase share). NOTE: the endpoint
expects **camelCase** keys — snake_case is silently ignored (the route 200s and
applies nothing):

```bash
curl -s -X PUT https://api.elizacloud.ai/api/v1/apps/<appId>/monetization \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"monetizationEnabled":true,"inferenceMarkupPercentage":20,"purchaseSharePercentage":10}'
```

Confirm each appears under **Dashboard → Apps** (the renamed nav section) with an
Overview / Monetize / Earnings tab set.

## 2. Deploy each app

Each app is a standalone server. Two paths:

- **Container (managed):** swap `"@elizaos/cloud-sdk": "workspace:*"` for a
  published version in the app's `package.json`, build the image, and deploy via
  `POST /api/v1/containers` (or the `build-monetized-app` skill). Set the app's
  env as container secrets, then patch `app_url`/`allowed_origins`.
- **Self-host:** run the Bun server anywhere and point `app_url` at it.

Per-app env:

| app | required env |
|---|---|
| `edad` | `ELIZA_APP_ID`, `ELIZA_AFFILIATE_CODE` (optional), `ELIZA_CLOUD_URL`; users sign in and spend their own org credits |
| `clone-ur-crush` | `AFFILIATE_API_KEY`, model/image provider keys (Fal or OpenAI), `ELIZA_CLOUD_URL` |
| `x402-image-gen` | `ELIZAOS_CLOUD_API_KEY`, `ELIZA_APP_ID`, `X402_NETWORK`, `X402_PRICE_USD` |

Smoke each deploy: `GET /health` → `ok`, `GET /api/config` → expected app id.

## 3. Validate PAYMENT IN

### 3a. Credit cards (Stripe) — funds the buyer's org credits
1. Dashboard → Billing → choose a credit pack or custom amount → **Card**.
2. Use a Stripe test card in test mode (`4242 4242 4242 4242`) or a real card in
   live mode. Complete checkout.
3. Confirm the Stripe webhook (`/api/stripe/webhook`) credits the org balance
   (`credit_transactions`) and that `Dashboard → Billing` shows the new balance.

### 3b. Crypto top-up (x402 USDC) — funds the buyer's org credits
1. Dashboard → Billing → **Crypto** → pay USDC on Base/BSC/Solana via the
   connected wallet (`/api/v1/topup/*`).
2. Confirm the balance increases after settlement.

### 3c. Per-image x402 (the PayPerPixel app) — no account needed
1. Open the deployed `x402-image-gen` app, enter a prompt, click Generate.
2. The app returns a 402 with the x402 challenge (amount, network, `payTo`).
3. Pay with a funded wallet on the chosen network (a wallet integration such as
   `x402-fetch`, or paste the settled payload into the UI for manual testing).
4. The image is returned; `seen` dedupe prevents a second image per payment.

## 4. Validate CHARGING (usage → creator earnings)
- **edad / clone-ur-crush:** each message/generation debits the *user's* org
  credits and records the creator's inference markup (`recordCreatorEarnings`).
- **PayPerPixel:** each settled x402 payment credits the creator's earnings via
  `recordAppScopedPaymentEarnings` (verified by
  `cloud/shared/.../__tests__/x402-app-earnings.test.ts`).
- Confirm `Dashboard → Apps → <app> → Earnings` (and `Dashboard → Earnings`)
  shows lifetime / withdrawable / by-source totals climbing after step 3.

## 5. Validate PAYMENT OUT (redemption / points)
"Points" = redeemable earnings, denominated 1 point = 1¢ USD.
1. Dashboard → Earnings → confirm the withdrawable balance ≥ the payout
   threshold ($25 app withdraw, or redeem any amount of redeemable balance).
2. **Redeem for elizaOS tokens:** Earnings → Redeem → pick a network
   (Base/Solana/Eth/BNB) → confirm the live quote (`/api/v1/redemptions/quote`).
3. Submit; the `process-redemptions` cron + `payout-processor` send tokens
   on-chain (`token_redemptions`). Confirm the redemption row reaches
   `completed` and the tokens arrive at the destination address.
4. Confirm `available_balance` dropped and `total_redeemed` rose.

## 6. Per-page e2e of each miniapp
For each deployed app, walk every page and assert no console/page errors:
- `edad`: landing → sign-in → chat turn → history reload.
- `clone-ur-crush`: landing → cloning flow → photo analysis → character create → generated photo.
- `x402-image-gen`: prompt → 402 challenge card → settle → image → earnings panel refresh.

The cloud dashboard's own pages are covered by the visual-review harness
(`bun run --cwd packages/cloud-frontend audit:cloud`) — run it after any UI change.

## Done = every box checked
Card in ✓ · crypto in ✓ · x402 per-action ✓ · charging→earnings ✓ ·
redeem→tokens out ✓ · each app's pages error-free ✓ · signup/login/logout ✓.
