# Cloud runtime Stripe sandbox acceptance

`certify-generic-billing-runtime-sandbox.ts` is an opt-in local acceptance runner.
It creates one isolated PostgreSQL schema, a test catalog, a three-seat no-card
trial through `GenericBillingRuntime`, and a Stripe Test Clock. The customer is
created by the real provider adapter with the durable command intent; a fixture
wrapper adds the Test Clock using the already-persisted trial start. The runtime
owns customer binding, trial creation, command finalization and subscription
projection. No payment method is added and no paid conversion is requested.

The receiver binds its local port before creating a schema or provider objects;
an occupied port fails before those mutations. During initialization it returns
503 so the forwarder can retry. The local HTTP signature boundary calls the production
`appBillingTriggerFromVerifiedEvent`, webhook receipt repository and
`AppBillingReconciliation.processPersisted`. Actual signed Stripe events must
arrive after Test Clock advancement. The runner requires both the provider and
database to report paused, an unchanged trial end, and an applied receipt for the
original subscription’s signed paused event. Every received app billing intake
and subscription receipt must be complete and free of errors. The runner invokes
canonical intake recovery while waiting, so transient conflicts must resolve
before acceptance; pending or failed receipts cannot pass.
It does not synthesize a signed event, poll the provider into the finalizer, or
call a dashboard-created subscription a Cloud acceptance result.

This boundary exercises shared production services. It does **not** exercise the
Worker route's middleware, audit dispatcher, Redis queue or deployed secrets.
Those remain a separate deployment acceptance requirement.

## Configuration and execution

Supply credentials through a private environment, never a committed file or a
command containing a literal key. The runner never reads `STRIPE_SECRET_KEY`.

Required environment variables:

- `GENERIC_BILLING_SANDBOX_RUN=1` explicitly enables test object creation.
- `GENERIC_BILLING_STRIPE_TEST_KEY` must be a dedicated `sk_test_` or `rk_test_` key.
- `GENERIC_BILLING_STRIPE_TEST_ACCOUNT` is the independently verified sandbox
  account ID. The candidate supplied by the operator is
  `acct_1SRAVXJlQ3uuhrev`; verify its Cloud merchant mapping before execution.
- `GENERIC_BILLING_STRIPE_TEST_ACCOUNT_KIND` is `platform` or `connected` and must
  match the actual account/Connect event topology. A platform run does not prove
  a connected merchant works.
- `GENERIC_BILLING_SANDBOX_POSTGRES_URL` names a disposable local PostgreSQL
  database. Only loopback hosts are accepted; URL query options are rejected.
- `GENERIC_BILLING_SANDBOX_WEBHOOK_SECRET` is the secret for the actual sandbox
  event forwarder. Do not use a live endpoint's secret.
- `GENERIC_BILLING_STRIPE_RECEIPT_PATH` optionally chooses a new private JSON
  receipt path. Existing files are rejected.

Before executing, start a sandbox-only Stripe event forwarder targeting
`http://127.0.0.1:43127/stripe/webhook`. It must forward snapshot events using
`2024-11-20.acacia` and the correct account topology, retain failed deliveries
until the local receiver starts, and supply its actual signing secret privately.
Forward subscription, invoice and Checkout lifecycle events. Verify the CLI or
endpoint's current Acacia support before running; an incompatible event version
is a failure, not grounds to rewrite or locally re-sign the event.

```sh
bun packages/cloud/shared/scripts/certify-generic-billing-runtime-sandbox.ts
```

Preflight makes read-only `/v1/account` and `/v1/balance` calls with the selected
account header. It rejects a different authoritative account ID, missing mode
or live mode before creating a schema or provider objects. Restricted test keys
need read access to account and balance plus sandbox catalog, customer,
subscription, invoice and Test Clock operations. An authorization failure must
be resolved by the operator; the runner never falls back to another credential.

The receipt records the run ID, schema, account, provider IDs, pending fixture
operation and signed event IDs. Fixture idempotency keys are
`billing-runtime-sandbox:<runId>:<operation>`; customer/subscription operations
use the actual database command journal. On failure, retain both schema and
receipt and reconcile those exact intents before considering another run.
A new invocation deliberately creates a distinct run. The runner retains test
objects and the schema for inspection; it does not delete the journal after
an ambiguous provider result. Disposal requires reviewing that run's IDs and
provider outcomes first.

## Local validation

```sh
bun test --config=/dev/null packages/cloud/shared/scripts/billing-sandbox-preflight.test.ts
APP_BILLING_TEST_POSTGRES_URL=postgresql://user@127.0.0.1:55437/postgres bun test --config=/dev/null --isolate packages/cloud/shared/scripts/billing-sandbox-database.postgres.test.ts
```

The preflight suite uses the real Stripe SDK with controlled HTTP. The schema
suite uses real PostgreSQL migrations, runtime, journal and finalizer with a
controlled Stripe transport. It also drives the exact local signature handler: unsigned
requests create no receipts, a signed cancellation finalizes once, exact replays
remain idempotent, and changed signed bytes with the same event ID return 409. Neither is evidence that a real sandbox run passed.
Real sandbox trial expiry, Connect topology, signed forwarding, paid conversion,
refund, metered usage, deployed Worker/queue handling and browser payment setup
remain unverified until those boundaries are actually exercised.
