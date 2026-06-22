# Monetized loop coverage (#8935)

End-to-end coverage of the autonomous monetized app/plugin/view lifecycle:
**create → deploy → domain → monetize → charge → autoscale → payout**.

Two specs cover the loop:

- [`tests/monetized-app-loop.spec.ts`](../tests/monetized-app-loop.spec.ts) — the
  ~70% baseline: create → monetize → buy-domain → earn → survival-economics.
- [`tests/monetized-full-loop.spec.ts`](../tests/monetized-full-loop.spec.ts) — the
  full loop this issue adds, with an explicit, observable state-transition
  assertion at every step (deploy node, charge, autoscale, payout-readiness).

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
| f | Charge (paid inference billing) | **covered** | scaffold (skipped) | deterministic ledger effects: org debit (`creditsService.deductCredits`) + matching creator earnings ledger entry (`redeemableEarningsService.addEarnings`). A REAL-LLM charge (end-user org debit + creator markup via Cerebras) is covered by [`creator-monetization-journey.spec.ts`](../tests/creator-monetization-journey.spec.ts) behind `CEREBRAS_API_KEY`. |
| g | Autoscale (daemon-driven) | **partial (mock)** | scaffold (skipped) | `node-autoscale` cron tick is observable (counter increments) + a provision replenishes the Hetzner pool by one running node. The cron→Hetzner wiring (a tick alone growing the pool) is **deferred** — see #8920/#8921 below. |
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

### #8921 — `cloud:mock --with-daemon` ✅ implemented

`cloud:mock --with-daemon` (`scripts/cloud/mock-stack-up.mjs`) runs the
autoscale / hot-pool / pool-replenish cron loops on real intervals against the
mock stack — POSTing each `/v1/cron/*` endpoint with the `CRON_SECRET` bearer on
a `DAEMON_TICK_MS` cadence (default 15s, fires once immediately). The pool is
then maintained by the daemon, not by test-enqueued ticks, so the loop can
assert daemon-driven pool maintenance over time. Timers are cleared on shutdown.

### #8922 — Stripe Connect fiat payout

There is **no fiat transfer mechanism** in this codebase — earnings redeem only
via Solana/EVM on-chain transfer. #8922 would add the Stripe Connect path
(connect-account onboarding → payout request → balance locked → fiat transfer
settled → balance drawn down). Until it lands, step (h) asserts the redeemable
balance as the payout-readiness proxy and the actual transfer is a clearly
annotated `test.skip` — **no Stripe transfer is faked**.

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
```

Relevant env (defaulted by `src/fixtures/env.ts`, override to tune): `MOCK_HETZNER_ACTION_MS`
(server transition window, default 30ms), `CONTROL_PLANE_TICK_MS`,
`ELIZA_CF_REGISTRAR_DEV_STUB=1` (CF registrar stub).
