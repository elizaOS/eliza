# Monetized loop coverage (#8935)

End-to-end coverage of the autonomous monetized app/plugin/view lifecycle:
**create → deploy → domain → monetize → charge → autoscale → payout**.

Two specs cover the loop:

- [`tests/monetized-app-loop.spec.ts`](../tests/monetized-app-loop.spec.ts) — the
  ~70% baseline: create → monetize → buy-domain → earn → survival-economics.
- [`tests/monetized-full-loop.spec.ts`](../tests/monetized-full-loop.spec.ts) — the
  full loop this issue adds, with an explicit, observable state-transition
  assertion at every step (deploy node, charge, autoscale, payout-readiness).

Both run per-PR on the mock stack via
[`.github/workflows/cloud-e2e.yml`](../../../../.github/workflows/cloud-e2e.yml)
(which globs every `packages/test/cloud-e2e/tests/*.spec.ts` and path-filters on
`packages/cloud-*/**` + `packages/test/**`). A real-Hetzner nightly variant runs
via
[`.github/workflows/monetized-loop-nightly.yml`](../../../../.github/workflows/monetized-loop-nightly.yml).

## Step-by-step coverage

| Step | Loop stage | Coverage (mock per-PR) | Real-Hetzner (nightly) | What is asserted / deferred |
| --- | --- | --- | --- | --- |
| a | Seed org with credits | **covered** | covered | org seeded with 1000 credits; `GET /credits/balance` == 1000. |
| b | `apps.create` | **covered** | covered | `POST /api/v1/apps` returns an app id. |
| c | Deploy / provision a node | **covered (mock)** | covered (live node) | control-plane provision job → Hetzner mock server `initializing → running`; pool +1 running node. Real run stands up an actual Hetzner server. |
| d | `domains.check` + `domains.buy` | **covered** | covered | CF registrar dev-stub debits exactly $14.95 (1099¢ + 396¢ margin); buy `success && verified`. Real run uses the live registrar. |
| e | `apps.monetization.update` | **covered** | covered | `PUT …/monetization` enables markup + purchase share; `GET …/monetization` reads back `monetizationEnabled: true`. |
| f | Charge (paid inference billing) | **covered** | covered | deterministic ledger effects: org debit (`creditsService.deductCredits`) + matching creator earnings ledger entry (`redeemableEarningsService.addEarnings`). A REAL-LLM charge (end-user org debit + creator markup via Cerebras) is covered by [`creator-monetization-journey.spec.ts`](../tests/creator-monetization-journey.spec.ts) behind `CEREBRAS_API_KEY`. |
| g | Autoscale (daemon-driven) | **partial (mock)** | covered (daemon) | `node-autoscale` cron tick is observable (counter increments) + a provision replenishes the Hetzner pool by one running node. The cron→Hetzner wiring (a tick alone growing the pool) is **deferred** — see #8920/#8921 below. |
| h | Payout (fiat) | **deferred** | deferred | redeemable balance asserted as the payout-readiness proxy; the actual fiat transfer is **skipped** (`test.skip`) — see #8922 below. No fiat payout mechanism exists today (only Solana/EVM on-chain redemption). |

## Deferred dependencies

These are real gaps, not test omissions. Each is referenced inline in the spec
and surfaced (rather than hidden) so the missing lane is visible in the report.

### #8920 — full provisioning-worker autoscale e2e

The mock stack proves the downstream effect of autoscale (a fresh node reaches
`running` and the pool replenishes), but the `node-autoscale` cron in the mock
returns `noop` and does not itself call Hetzner. #8920 would run the **real
provisioning-worker autoscale loop** end to end so that a single cron tick
observes capacity pressure and provisions a node without a manually enqueued
provision job — closing the gap between "tick is observable" and "tick grows the
pool".

### #8921 — `cloud:mock --with-daemon`

The mock stack has no long-running autoscale daemon; the test drives ticks
explicitly. #8921 would add a `--with-daemon` mode to `cloud:mock` that runs the
autoscale/hot-pool daemons on their real intervals against the mock stack, so the
loop can assert daemon-driven (not test-driven) pool maintenance over time.

### #8922 — Stripe Connect fiat payout

There is **no fiat transfer mechanism** in this codebase — earnings redeem only
via Solana/EVM on-chain transfer. #8922 would add the Stripe Connect path
(connect-account onboarding → payout request → balance locked → fiat transfer
settled → balance drawn down). Until it lands, step (h) asserts the redeemable
balance as the payout-readiness proxy and the actual transfer is a clearly
annotated `test.skip` — **no Stripe transfer is faked**.

## Running the loop locally (mock stack)

```bash
# all cloud e2e specs
bun run cloud:e2e

# just the full loop (the registrar dev-stub is on by default via the env fixture)
bun run cloud:e2e -- monetized-full-loop.spec.ts
```

Relevant env (defaulted by `src/fixtures/env.ts`, override to tune): `MOCK_HETZNER_ACTION_MS`
(server transition window, default 30ms), `CONTROL_PLANE_TICK_MS`,
`ELIZA_CF_REGISTRAR_DEV_STUB=1` (CF registrar stub).
