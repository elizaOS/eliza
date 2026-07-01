# Monetized loop coverage (#8935)

End-to-end coverage of the autonomous monetized app/plugin/view lifecycle:
**create → deploy → domain → monetize → charge → autoscale → payout**.

Two specs cover the loop:

- [`tests/monetized-app-loop.spec.ts`](../tests/monetized-app-loop.spec.ts) — the
  ~70% baseline: create → monetize → buy-domain → earn → survival-economics.
- [`tests/monetized-full-loop.spec.ts`](../tests/monetized-full-loop.spec.ts) — the
  full loop this issue adds, with an explicit, observable state-transition
  assertion at every step (deploy node, charge, autoscale, payout-readiness).

> **See also (#9300):** [`tests/example-apps-showcase.spec.ts`](../tests/example-apps-showcase.spec.ts)
> drives the same loop specifically for the two flagship example apps (EDAD,
> Clone Ur Crush) - including **app-subdomain** wiring (the ingress on-demand-TLS
> gate) - from a dedicated **infinite-credit showcase account**. Full runbook:
> [`docs/showcase-apps-coverage.md`](./showcase-apps-coverage.md).

The mock-stack loop runs per-PR via
[`.github/workflows/cloud-e2e.yml`](../../../../.github/workflows/cloud-e2e.yml)
(which globs every `packages/test/cloud-e2e/tests/*.spec.ts` and path-filters on
`packages/cloud-*/**` + `packages/test/**`) — this is the **active coverage**. A
nightly [`.github/workflows/monetized-loop-nightly.yml`](../../../../.github/workflows/monetized-loop-nightly.yml)
is wired as the **real-Hetzner parity scaffold**: it sets `MONETIZED_LOOP_REAL=1`,
under which `monetized-full-loop.spec.ts` skips the whole suite (a describe-level
skip, so the mock stack is never booted). Wiring the live-infra driver — one that
drives `MONETIZED_LOOP_BASE_URL` with a real Eliza Cloud key instead of the mock
`stack` fixture — is a tracked #8935 follow-up; until then the nightly is an
honest scaffold (green-but-skipped), never mock assertions masquerading as real.

## Step-by-step coverage

| Step | Loop stage | Coverage (mock per-PR) | Real-Hetzner (nightly) | What is asserted / deferred |
| --- | --- | --- | --- | --- |
| a | Seed org with credits | **covered** | scaffold (skipped) | org seeded with 1000 credits; `GET /credits/balance` == 1000. |
| b | `apps.create` | **covered** | scaffold (skipped) | `POST /api/v1/apps` returns an app id. |
| c | Deploy / provision a node | **covered (mock)** | scaffold (skipped) | control-plane provision job → Hetzner mock server `initializing → running`; pool +1 running node. The live driver (follow-up) would stand up an actual Hetzner server. |
| d | `domains.check` + `domains.buy` | **covered** | scaffold (skipped) | CF registrar dev-stub debits exactly $14.95 (1099¢ + 396¢ margin); buy `success && verified`. The live driver (follow-up) would use the real registrar. |
| e | `apps.monetization.update` | **covered** | scaffold (skipped) | `PUT …/monetization` enables markup + purchase share; `GET …/monetization` reads back `monetizationEnabled: true`. |
| f | Charge (paid inference billing) | **covered** | scaffold (skipped) | deterministic ledger effects through the real per-app billing service: `appCreditsService.deductCredits` computes markup from the app monetization config, debits base+markup from the org ledger, records app-scoped earnings, and raises the creator redeemable balance by exactly the computed markup. The full `POST /api/v1/messages` + `x-app-id` HTTP seam (route → `calculateCostWithMarkup` → `generateText` → `billUsage` → `reconcileCredits`) runs **always-on, no paid key** in [`monetized-mock-llm-journey.spec.ts`](../tests/monetized-mock-llm-journey.spec.ts) via an in-process OpenAI mock (`stackOptions.mockLlm`, asserting the mock served the request so the charge is from real usage); the same seam against a REAL LLM (Cerebras) is in [`creator-monetization-journey.spec.ts`](../tests/creator-monetization-journey.spec.ts) behind `CEREBRAS_API_KEY`. |
| g | Autoscale (daemon-driven) | **covered** | scaffold (skipped) | `node-autoscale` cron tick is observable, and the `agent-hot-pool` daemon cron tick **alone** replenishes the warm pool to its target (`replenishWarmPool`) — no test-enqueued provision job. The real Hetzner node `initializing → running` transition is asserted in step (c). |
| h | Payout (fiat) | **covered** | scaffold (skipped) | the redeemable balance is the payout-readiness proxy, and a dedicated test exercises the full Stripe Connect fiat withdrawal: onboarding → account.updated webhook → ledger debit → transfer → **balance draws down by exactly the payout**, plus the compensating refund on a simulated Stripe failure and the `payout.paid` webhook. Runs against the live PGlite DB + real ledger/repo/service; only the Stripe SDK boundary is mocked (the injectable client). See #8922 below. |

## Dependencies

### #8920 — local autoscale-loop integration test against the Hetzner mock ✅ implemented

The control-plane mock runs the autoscale / hot-pool / pool-replenish crons. The
`agent-hot-pool` cron replenishes the warm pool toward its target on each tick
(`store.replenishWarmPool`), so step (g) raises the hot-pool target, ticks the
cron once, and asserts the tick **alone** grew the pool to target — no
test-enqueued provision job. Combined with #8921's `--with-daemon` interval
ticking, the pool is maintained by the daemon, not by manual ticks. Real Hetzner
node provisioning (`initializing → running`) is exercised separately in step (c).

### #8921 — `cloud:mock --with-daemon` ✅ implemented

`cloud:mock --with-daemon` (`scripts/cloud/mock-stack-up.mjs`) runs the
autoscale / hot-pool / pool-replenish cron loops on real intervals against the
mock stack — POSTing each `/v1/cron/*` endpoint with the `CRON_SECRET` bearer on
a `DAEMON_TICK_MS` cadence (default 15s, fires once immediately). The pool is
then maintained by the daemon, not by test-enqueued ticks, so the loop can
assert daemon-driven pool maintenance over time. Timers are cleared on shutdown.

### #8922 — Stripe Connect fiat payout ✅ implemented + e2e-covered

The Stripe Connect rail is implemented: the onboarding / transfer / webhook
routes (`packages/cloud/api/v1/earnings/payout/stripe-connect/*`), the
SDK-agnostic payout service (`stripe-connect-payout.ts`), the accounts repo +
schema + migration `0150`. The transfer route is admin-gated and runs a
compensating saga (validate → debit ledger → transfer → re-credit on failure)
with a Stripe idempotency key. Step (h)'s dedicated test exercises that flow
end-to-end against the live DB — onboarding, the `account.updated`/`payout.paid`
webhook mappings, the ledger draw-down, and the failure-path refund — with only
the Stripe SDK boundary mocked via the injectable `StripeConnectClient` (the same
seam the route's `requireStripe()` fills). No real money moves; nothing is faked
beyond the SDK call. Follow-up (tracked on #8922): a dedicated `payout` ledger
entry type — the balance math is already correct, only the entry label differs.

### Nightly live-infra driver (#8935 follow-up)

The nightly workflow is wired and honest-skips, but the spec itself has no
real-mode path yet: under `MONETIZED_LOOP_REAL=1` it skips at the describe level
rather than driving live infra. The follow-up is a real-mode loop that does **not**
use the mock `stack` fixture — it hits `MONETIZED_LOOP_BASE_URL` with
`CLOUD_E2E_API_KEY`, lets autoscale/provision stand up an actual Hetzner node, and
performs a real (CI-project-scoped, teardown-guaranteed) domain + node lifecycle.
It is intentionally not faked here because it spends real credits and real Hetzner
capacity.

## Running the loop locally (mock stack)

```bash
# all cloud e2e specs
bun run cloud:e2e

# just the full loop (the registrar dev-stub is on by default via the env fixture)
bun run cloud:e2e -- monetized-full-loop.spec.ts

# the always-on real-HTTP-seam charge test (boots an in-process OpenAI mock; no key)
bun run cloud:e2e -- monetized-mock-llm-journey.spec.ts
```

Relevant env (defaulted by `src/fixtures/env.ts`, override to tune): `MOCK_HETZNER_ACTION_MS`
(server transition window, default 30ms), `CONTROL_PLANE_TICK_MS`,
`ELIZA_CF_REGISTRAR_DEV_STUB=1` (CF registrar stub).
