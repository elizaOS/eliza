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

Turn on monetization for each (markup + purchase share):

```bash
curl -s -X PUT https://www.elizacloud.ai/api/v1/apps/<appId>/monetization \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"monetization_enabled":true,"inference_markup_percentage":20,"purchase_share_percentage":10}'
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
  `cloud-shared/.../__tests__/x402-app-earnings.test.ts`).
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
