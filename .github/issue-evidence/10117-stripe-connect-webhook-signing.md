# #10117 — Harden money-out: sign-verify the Stripe Connect payout webhook + scope payment-request expiry

Two money-OUT hardening fixes from the cloud payment-routes audit.

## 1) Stripe Connect payout webhook now verifies the signature (was: none)

**Before:** `v1/earnings/payout/stripe-connect/webhook/route.ts` did
`request.json()` and applied the event directly. Its docstring falsely claimed
*"Signature verification is handled by the existing Stripe webhook middleware"* —
no such middleware exists; the path is in `publicPathPrefixes` (unauthenticated).
A forged `account.updated` could corrupt a creator's connect-account status.

**After:** the handler verifies the `Stripe-Signature` header over the **raw
body** against a dedicated **`STRIPE_CONNECT_WEBHOOK_SECRET`** (Connect endpoints
have their own secret, distinct from `STRIPE_WEBHOOK_SECRET`) using
`stripe.webhooks.constructEventAsync` (WebCrypto; Workers-safe), with a 300s
timestamp tolerance — mirroring the main `stripe/webhook` route:

- **No signature** → `400`, before any verify or DB write.
- **Missing `STRIPE_CONNECT_WEBHOOK_SECRET`** → `500` **fail-closed** (never
  trusts an unverified payload; the secret is an ops dependency — set via
  `wrangler secret put STRIPE_CONNECT_WEBHOOK_SECRET` + the Stripe dashboard
  Connect endpoint).
- **Invalid/forged/tampered/stale signature** → `400` **and** an audit event
  (`redemption.payout` / `result: denied` / `resource: stripe-connect`), **no DB
  write**.
- **Valid** → maps + applies the connect-account status as before.
- The false docstring is corrected.

Files: `route.ts` (verification), `types/cloud-worker-env.ts` (new
`STRIPE_CONNECT_WEBHOOK_SECRET` binding), `api/wrangler.toml` (secret documented).

## 2) payment-request `expire` is now org-scoped (was: global cross-tenant sweep)

**Before:** `v1/payment-requests/[id]/expire/route.ts` authorized via
`service.get(id, org)` but then called `service.expirePast(now)` →
`repository.expirePastPaymentRequests(now)`, an **unscoped** UPDATE flipping
*every* org's past-due `pending`/`delivered` rows. Any authed user expiring their
own request triggered a global sweep (least-privilege / blast-radius bug).

**After:** added `expirePastPaymentRequestsForOrg(orgId, now)` (repository) +
`expirePastForOrg(orgId, now)` (service); the route calls the org-scoped variant.
The global `expirePast` is retained for the cron janitor only.

Files: `db/repositories/payment-requests.ts`, `lib/services/payment-requests.ts`,
`v1/payment-requests/[id]/expire/route.ts`.

## Evidence — real tests (run on this branch)

### Route control-flow + **real-crypto** signature verification (no mock)

```
$ bun test __tests__/stripe-connect-webhook-route.test.ts
Stripe Connect payout webhook route
  ✓ rejects 400 with no Stripe signature, before any verify or DB write
  ✓ fail-closes 500 when the Connect signing secret is not configured
  ✓ fail-closes 500 when Stripe itself is not configured
  ✓ rejects 400 and audit-logs a denial on invalid signature — no DB write
  ✓ classifies a stale-timestamp failure distinctly in the audit log
  ✓ applies the connect-account status for a verified account.updated event
  ✓ verifies a transfer.created event and advances payout status (no status patch)
  ✓ ignores verified-but-irrelevant event types without touching the DB
Stripe Connect webhook — real signature verification (no mock)
  ✓ accepts a correctly-signed Connect event
  ✓ rejects a forged body re-using a valid signature (tamper attack)
  ✓ rejects an event signed with the wrong secret (no shared secret)
  ✓ rejects an event with no signature header at all
  ✓ rejects a stale timestamp outside the tolerance window
13 pass / 0 fail / 35 expect() calls
```

The "real signature verification" suite uses the **actual Stripe SDK** (no
mock): it signs a payload with `generateTestHeaderStringAsync` and asserts
`constructEventAsync` accepts only the correctly-signed payload and **rejects**
the forged-body, wrong-secret, no-signature, and stale-timestamp cases — i.e. the
exact attack the issue describes is provably blocked end-to-end (local
HMAC-SHA256; no network).

### Main billing webhook regression (unchanged) + service org-scoping

```
$ bun test __tests__/stripe-connect-webhook-route.test.ts __tests__/stripe-webhook-route.test.ts
17 pass / 0 fail / 52 expect() calls

$ bun test src/lib/services/payment-requests.test.ts   # (cloud/shared)
  ✓ rejects providers without a real adapter before creating a row
  ✓ expirePastForOrg only sweeps the caller's org and never the global sweep
  ✓ expirePast (cron) still uses the global sweep
3 pass / 0 fail / 7 expect() calls
```

The org-scoping test installs a fake repository whose **global** sweep *throws*,
so any regression that reintroduces the cross-tenant sweep from the authed route
fails loudly.

### `bun run verify` (typecheck + lint) — changed files

- `biome check` on all changed files: clean.
- `tsgo`/`tsc` typecheck filtered to the changed files: no errors.

## Live round-trip — N/A (ops dependency, by design)

A live Stripe Connect round-trip needs `STRIPE_CONNECT_WEBHOOK_SECRET` wired in
wrangler + prod + a configured Stripe dashboard Connect endpoint — the ops
dependency the issue explicitly calls out. Shipping the code **before** the
secret exists fail-closes the endpoint (the intended safe state). The real-crypto
suite above proves the verification itself with a known secret, so the live step
is reduced to "set the secret," not "trust unverified code."
