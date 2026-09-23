# Generic billing Stripe sandbox

The provider adapters keep Cloud's global Stripe API pin unchanged and request
`2024-11-20.acacia` explicitly for every account-scoped operation. Production
callers must supply the durable binding resolver, persist the command intent
before dispatch, retain its idempotency key through ambiguous outcomes, and
finalize authoritative observations under the database generation and seat fence.
Metadata-only reads are a controlled-fixture compatibility mode, not production
ownership authority. Existing objects with absent metadata are accepted only
through exact persisted account, environment and object bindings; contradictory
metadata fails.

Plan and quantity changes use `previewSubscriptionUpdate`, followed by a durable
buyer review and `updateSubscription` with the stored preview. Confirmation
re-previews and rejects changed subscription or monetary facts. The same fixed
proration timestamp is sent to the mutation. The runtime must enforce quote
expiry, user consent and the occupied-seat fence. Stripe previews do not reserve
prices, taxes or external account state. Generic portal sessions always disable
subscription updates. Trial updates preserve the original subscription and trial
end. Trial claims carry their original seven-day UTC interval into dispatch;
a delayed request never starts a fresh seven-day promise.

Run the controlled HTTP boundary suite from the repository root:

```sh
bun test packages/cloud/shared/src/lib/services/generic-billing-provider.test.ts packages/cloud/shared/src/lib/services/generic-billing-merchant-provider.test.ts packages/cloud/shared/scripts/certify-generic-billing-stripe.test.ts
```

These tests use the installed Stripe SDK and a controlled HTTP transport. They
validate account headers, Acacia payloads, ownership, quote revalidation, trial
preservation and provider failures. They are not evidence of real Stripe behavior.

For a real test-mode trial-expiry smoke, configure these environment variables
through a secret manager or private shell environment:

- `GENERIC_BILLING_SANDBOX_RUN=1`
- `GENERIC_BILLING_STRIPE_TEST_KEY`: a dedicated `sk_test_` or `rk_test_` credential
- `GENERIC_BILLING_STRIPE_TEST_ACCOUNT`: the exact registered test `acct_` account
- `GENERIC_BILLING_STRIPE_TEST_ACCOUNT_KIND`: `platform` or `connected`
- `GENERIC_BILLING_STRIPE_RECEIPT_PATH`: optional new, private receipt file

```sh
bun packages/cloud/shared/scripts/certify-generic-billing-stripe.ts
```

The command rejects live-key prefixes, never falls back to `STRIPE_SECRET_KEY`,
and checks the credential's actual balance environment before creating objects.
It creates a disposable Test Clock, product, recurring test price and customer;
starts the fixed no-card trial through the adapter; advances the clock past the
trial end; and requires authoritative `paused` state without trial extension.
It never adds a payment method or initiates a payment.

The command prints a private intent-journal path before the first mutation and
records every pending operation and provider ID there. If execution fails,
reconcile that journal and its original idempotency keys before deciding whether
to start another run. Test objects remain available for inspection. The completed
receipt labels this as a provider trial smoke, not full billing certification.
Real signed Worker webhook delivery, the transactional database finalizer, buyer
review UI, setup Checkout, paid conversion, refund and Connect onboarding must
be exercised in the composed test stack before enabling production subscriptions.
No production Stripe credential is suitable for that acceptance run.

The wire contracts are documented by Stripe's
[Acacia preview endpoint](https://docs.stripe.com/api/invoices/create_preview?api-version=2024-11-20.acacia),
[Acacia subscription update endpoint](https://docs.stripe.com/api/subscriptions/update?api-version=2024-11-20.acacia),
and [Acacia PaymentIntent object](https://docs.stripe.com/api/payment_intents/object?api-version=2024-11-20.acacia).
Acacia subscription periods are top-level fields. Recurring invoice previews do
not support trials, so a trial review presents the next renewal invoice and zero
due now; it does not label that renewal as a long-term recurring estimate.
