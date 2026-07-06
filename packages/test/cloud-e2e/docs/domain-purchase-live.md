# Live domain purchase e2e — money-gated operator lane (#10691)

The full Cloud-apps money path — **create app → deploy → buy a real domain →
active → serves → detach** — driven against live infrastructure with a real
Cloudflare registration and a real credit debit. Because a run spends real,
non-refundable money, it is **never run by CI**: it is operator-gated behind an
explicit env switch and skips loudly (with the exact vars to set) otherwise.

Two complementary specs share one helper set
(`src/helpers/domain-purchase.ts`):

| Spec | Lane | Costs money |
| --- | --- | --- |
| `tests/domain-purchase.real.spec.ts` | live staging/prod registrar | **YES** (one cheap TLD per run, ≤ the ceiling) |
| `tests/domain-purchase-harness.spec.ts` | mock stack, registrar dev stub | no — harness-logic verification only, runs in the normal mock suite |

## The single operator command (THE PAID RUN)

```bash
ELIZA_LIVE_DOMAIN_PURCHASE=1 \
ELIZA_LIVE_DOMAIN_BASE_URL=https://api-staging.elizacloud.ai \
CLOUD_E2E_API_KEY=<funded operator org API key> \
bun run --cwd packages/test/cloud-e2e test tests/domain-purchase.real.spec.ts
```

All three vars are required; if any is missing the whole suite skips with a
`[domain-purchase.real] SKIP (no money spent): …` console line naming the
missing vars, and exits green. CI never sets them, so CI can never spend money.

Optional knobs (defaults in parentheses):

| Var | Purpose |
| --- | --- |
| `ELIZA_LIVE_DOMAIN_MAX_PRICE_CENTS` (`500`) | Price ceiling in US cents. The run **fails before buying** if the cheapest available quote exceeds it — a registrar pricing change can never silently make the test expensive. |
| `ELIZA_LIVE_DOMAIN_TLDS` (`xyz,click,sbs`) | Comma-separated cheap candidate TLDs. Each is quoted via `domains/check` (no charge) with a unique base36 run slug (`e2e-10691-<runId>.<tld>`); the cheapest available one is bought. |
| `ELIZA_LIVE_DOMAIN_UNFUNDED_API_KEY` (unset) | A second, deliberately **zero-balance** org key. Enables the two negatives that need a second tenant: insufficient credits → `402` and cross-tenant re-buy → `409`. When unset those cases skip loudly. |
| `ELIZA_DOMAIN_LEDGER_PATH` (`domain-purchase-ledger/ledger.jsonl` in this package) | Where purchase records are appended. |
| `ELIZA_LIVE_DOMAIN_DEPLOY_CAP_MS` / `ELIZA_LIVE_DOMAIN_STATUS_CAP_MS` / `ELIZA_LIVE_DOMAIN_SERVE_CAP_MS` (10 min each) | Poll caps for deploy → READY, registration → active+verified, and public-DNS serving. |
| `ELIZA_LIVE_DOMAIN_DEPLOY_REPO_URL` / `_REF` / `_DOCKERFILE` (elizaOS/eliza @ develop, the EDAD `Dockerfile.cloud`) | Source-build hints for the real container deploy — same shape as the EDAD live driver. |

### Environment prerequisites (operator-side, on the target API)

- The org behind `CLOUD_E2E_API_KEY` must be funded above the ceiling.
- The target environment must run the **real** Cloudflare registrar
  (`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`; the buy route refuses to
  boot with `ELIZA_CF_REGISTRAR_DEV_STUB=1` in production).
- Automatic DNS for purchased domains requires
  `ELIZA_CUSTOM_DOMAIN_ORIGIN_IP` or `ELIZA_CUSTOM_DOMAIN_ORIGIN_HOST` on the
  worker (the apps front door Caddy). Without it the buy route logs
  `[Domains Buy] no container target — DNS not configured automatically` and
  the serve step (7b) will fail even though registration + charge succeeded
  (both are still ledgered).

## What a run asserts, in order

1. **Auth preflight** — `GET /credits/balance` 200; balance ≥ ceiling.
2. **Create app** — `POST /apps` (run-slugged name).
3. **Deploy** — `POST /apps/:id/deploy` (real source build) → poll to `READY`
   → fetch the `production_url` (must serve 200 before the domain step).
4. **Quote + price ceiling** — `POST /apps/:id/domains/check` on every
   candidate TLD; the cheapest available quote must be ≤ the ceiling or the
   test **fails before any buy request is made**
   (`PriceCeilingExceededError`, listing every quote).
5. **Buy** — `POST /apps/:id/domains/buy` → 200, `debited.totalUsdCents` ≤
   ceiling, and the org balance drops by exactly the reported debit.
6. **Active** — `POST /apps/:id/domains/status` polled to
   `status=active && verified=true`.
7. **Serves** — `GET /apps-ingress/ask?domain=…` 200 (on-demand TLS
   authorized), then `https://<domain>` (or `http://` while TLS issues)
   answers < 500 within the cap.
8. **Zero-cost negatives while owning the domain** —
   - idempotent re-buy → 200 replay of the cached purchase, balance unchanged
     (single-flighted by the buy route's idempotency claim);
   - cross-tenant re-buy from the second org (when the unfunded key is set)
     → 409, second org balance unchanged.
9. **Cleanup (`finally`)** — `DELETE /apps/:id/domains` (detach) +
   `DELETE /apps/:id`; detach outcome is ledgered.

Separate zero-cost tests in the same gated describe:

- **Unavailable domain → 409, no charge** — `example.com` (IANA-reserved) is
  checked (`available:false`) then bought → 409; balance unchanged.
- **Insufficient credits → 402, fail-closed** (needs
  `ELIZA_LIVE_DOMAIN_UNFUNDED_API_KEY`) — the broke org quotes a fresh cheap
  domain, buys → 402 `insufficient_balance`, balance unchanged, and a
  re-check shows the domain **still available** (the decline happened before
  any registrar call, so nothing was registered on a non-debit).

## Negatives that are NOT deterministically reachable live — and where they live instead

- **Registrar failure after debit → refund → 502.** There is no way to inject
  a Cloudflare failure mid-purchase on staging/prod, so the live lane does not
  fake it. The seam is exercised deterministically in
  `tests/domain-purchase-harness.spec.ts` against the registrar dev stub: a
  `fail-<slug>` domain makes `registerDomain` throw AFTER the debit, and the
  test asserts the 502 plus a full refund (net-zero balance).
- **Deterministic credit drain for the 402.** The API deliberately exposes no
  self-serve "spend/zero my balance" endpoint (`creditsService.deductCredits`
  is service-internal). Burning a funded org down via inference is slow and
  nondeterministic, so the live 402 case is gated on an operator-provisioned
  zero-balance key instead; the mock lane seeds a `creditBalance: "0.000000"`
  org and covers the same route path unconditionally.

## Purchase ledger

Cloudflare registrations are **non-refundable** — detach only removes the app
attachment; the registration stays until expiry. Every attempt and outcome is
therefore appended (JSONL, append-only) to:

```
packages/test/cloud-e2e/domain-purchase-ledger/ledger.jsonl   (default)
```

One line per lifecycle event (`attempt` → `purchased`/`buy-failed` →
`detached`/`detach-failed`) with: `runId`, `timestamp`, `mode`
(`live`/`mock-stub`), `baseUrl`, `domain`, `appId`, `quotedTotalUsdCents`,
`priceCeilingCents`, `debitedTotalUsdCents`, `zoneId`, `appDomainId`,
`expiresAt`, `detachStatus`, `error`. The dir is **not** gitignored — commit
the ledger after a paid run as spend evidence.

Inspect prior purchases + total spend:

```bash
bun run --cwd packages/test/cloud-e2e domains:ledger
# or raw:
jq -r 'select(.phase=="purchased") |
  [.timestamp,.runId,.domain,((.debitedTotalUsdCents//0)|tostring)+"¢",.zoneId//"-"] | @tsv' \
  packages/test/cloud-e2e/domain-purchase-ledger/ledger.jsonl
```

The mock harness spec writes its ledger to the per-test Playwright output dir
(and asserts its shape) so stub runs never pollute the real spend record.

### Known API gap: no registration id in any response

The buy route creates a Cloudflare registration id internally but **no
cloud-api response exposes it** — not `domains/buy` (returns
`appDomainId`/`zoneId`), not `domains/status`, not the per-app or org domain
listings. The ledger keeps a `cloudflareRegistrationId` field (always `null`
today) so records become complete if/when the API starts returning it.

## Harness-logic verification (no money)

```bash
bun run --cwd packages/test/cloud-e2e test tests/domain-purchase-harness.spec.ts
```

Runs in the normal mock suite (`bun run cloud:e2e`) against the booted stack
with `ELIZA_CF_REGISTRAR_DEV_STUB=1`: the full chain (with the mock
control-plane pumping the deploy worker and the app's mock-container
`production_url` standing in for public DNS), the ceiling refusal, the 409 /
402 / 502-refund / cross-tenant / idempotent-re-buy negatives, and the ledger
format. **This is harness-logic verification, not money-path evidence** — the
paid run above is the only real proof, per `AGENTS.md`.
