# Cloud app staging acceptance

Date: 2026-08-21

This is the operator handoff for taking the locally accepted coding/app runtime
into an authenticated Eliza Cloud staging exercise. It does not authorize a
deployment, charge, database allocation, payout, domain purchase, or other
remote mutation.

The immutable local runtime baseline is:

- commit `86c6129f98283189a0531d8f509c3fea74592b32`;
- tag `coding-runtime/local-candidate-20260821-v4`;
- UI `http://127.0.0.1:2638/chat` and API `http://127.0.0.1:32637` when the
  isolated QA runtime is running;
- protected Cerebras provider account, with no raw provider key in the runtime
  process.

## What local acceptance now proves

One focused full-stack mock run passed all three journeys:

```bash
bun run cloud:e2e -- \
  monetized-mock-llm-journey.spec.ts \
  redemption-flow.spec.ts \
  remote-app-deploy.spec.ts
```

Results: 3 passed, 0 failed in 38.9 seconds.

- A separate end-user organization made an inference call, its balance
  decreased, and both creator redeemable earnings and app earnings increased.
- The redemption path produced a quote and request, denied cross-user access,
  denied non-admin approval, and allowed the seeded admin approval.
- The app-owned deployment job reached `READY`, exposed a reachable production
  URL, and preserved the canonical local app definition.

Focused Bun tests passed 35 checks with 0 failures:

- deploy request schema accepts an explicit prebuilt image and rejects invalid
  references: 2 passed;
- app database mode defaults safely and accepts only `none` or `isolated`: 3
  passed;
- deployment image selection, allowlisting, per-organization namespace grants,
  and optional digest pinning: 28 passed;
- isolated database DSN injection and teardown behavior: 2 passed.

The mock stack exercises the real API, job, ledger, authorization, and database
code around substituted provider boundaries. It does not prove a real Hetzner
VM/container, live Stripe or token transfer, production database placement, or
Cloud staging credentials. The existing `MONETIZED_LOOP_REAL=1` nightly path
still skips because the real-infrastructure driver has not been implemented.

## Canonical staging object

Use exactly one Cloud `appId` for the entire lifecycle. Do not create a second
app for frontend hosting, the backend container, monetization, or the database.

1. `apps.create` creates the canonical identity only if no suitable staging app
   already exists.
2. `apps.frontend.deploy` and `apps.frontend.activate` own managed static
   frontend versions for that app.
3. `apps.database.update` selects `none` or `isolated` for the same app. The
   database binding applies on its next backend deployment.
4. `apps.deploy` starts the app-owned backend deployment only when a server is
   actually required. An approved, allowlisted, digest-pinned image is the
   preferred staging input.
5. `apps.review.submit` and `apps.review.get` gate monetization.
6. `apps.monetization.update`, paid inference, earnings, billing ledger, and
   payout reads all remain attached to that same `appId`.

A static-only app does not need a Hetzner container or isolated database.

## Read-only preflight

These commands do not create an app or spend credits:

- `cloud.health`
- `user.get`
- `credits.balance`
- `credits.summary`
- `apps.list`
- `apps.get`
- `apps.frontend.list`
- `apps.database.get`
- `apps.deploy.status`
- `apps.monetization.get`
- `apps.analytics.requests`
- `containers.quota`
- `redemptions.balance`
- `redemptions.quote`
- `billing.active`
- `billing.ledger`

Before any mutation, capture a secret-free baseline containing the staging base
URL, source commit/tag, organization identifier, canonical app ID (if one
exists), credit balance, container quota/runway, current frontend version,
database mode, deploy status, monetization state, creator earnings, and billing
ledger cursor. Never copy API keys, cookies, bearer headers, payout credentials,
database URLs, or provider secrets into the evidence package.

## Mutation gates

Each phase below needs explicit operator authority at the time it is run.

### Managed frontend

1. Reuse the canonical staging app or approve one `apps.create` call.
2. Publish the verified static bundle with `apps.frontend.deploy`.
3. Inspect the returned version, then activate that exact version.
4. Load the public URL and assert the expected heading, interaction, and
   same-origin API behavior.

Record the previous active version before activation so rollback can reactivate
it without creating another app.

### Hetzner-backed app container

Only run this phase for an app that needs a private server, same-origin model
proxy, long-running process, or app database.

1. Confirm `containers.quota` reports enough credit runway.
2. Verify the image is operator-approved, registry-allowlisted, and pinned as
   `ghcr.io/<approved-namespace>/<image>@sha256:<digest>`.
3. Call `apps.deploy` on the canonical app; do not use `containers.create` to
   make a parallel generic container.
4. Poll `apps.deploy.status` through its real state transitions to `READY`.
5. Verify the production URL, container identity, health check, structured
   logs, and billing resource.

Acceptance requires real Hetzner control-plane/container evidence. A mock
`READY` result is not sufficient.

### Isolated production-style app database

1. Set `apps.database.update` to `isolated` before the backend deployment.
2. Deploy the same app and wait for `READY`.
3. Read `apps.database.get` and verify the database is bound to that deploy.
4. Through the app's authenticated API, create one uniquely named canary row,
   read it back, restart or redeploy once, and read it back again.
5. Prove a different app/organization cannot read the canary.

Do not print or preserve the database DSN. Teardown or mode changes are a
separate destructive approval because they may delete or strand app data.

### Credit debit and creator earnings

1. Require compliance review approval before enabling monetization.
2. Record the independent end-user balance, creator app earnings, redeemable
   earnings, and billing ledger cursor.
3. Enable a small staging markup with `apps.monetization.update`.
4. Make one bounded real inference request as an independent end user with the
   canonical `x-app-id` and, when applicable, `x-affiliate-code`.
5. Poll deferred settlement rather than asserting immediately.
6. Require a nonzero user debit, one matching usage record, creator earnings
   increase, correct base/markup split, and no duplicate ledger entries when
   the idempotency key is retried.

This phase intentionally spends staging credits and needs explicit approval.

### Creator payout

Balance and quote reads are preflight-only. Creating a redemption or Stripe
transfer moves value and requires separate explicit approval.

1. Read creator earnings, redemption balance, payout readiness, and quote.
2. Validate ownership and confirm a different user cannot read the payout.
3. Submit one bounded redemption with a unique idempotency key.
4. Verify non-admin approval fails and the authorized review path succeeds.
5. For a live transfer, reconcile the creator balance, payout ledger, provider
   transfer ID, webhook, and compensating refund behavior before acceptance.

## Evidence and stop conditions

The staging bundle must contain only sanitized request/response metadata,
timestamps, IDs safe to disclose, state transitions, balance deltas, ledger
entry types/amounts, health results, and screenshots of the user-facing app.

Stop without retrying into a broader action when any of these occurs:

- source commit/tag does not match the approved candidate;
- Cloud app identity changes between phases;
- compliance review is absent or rejected;
- credit reservation/debit is missing, duplicated, or not reconciled;
- creator earnings do not settle or differ from the configured markup;
- image is mutable, outside the allowlist, or not operator-approved;
- database binding is absent, cross-tenant accessible, or loses the canary;
- deployment status is ambiguous, terminally failed, or not backed by real
  Hetzner evidence;
- payout identity, amount, idempotency, or refund behavior is unclear.

The next remote step is therefore a read-only staging preflight. It must not be
silently expanded into creation, deployment, charging, or payout.
