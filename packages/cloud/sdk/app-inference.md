# App customer inference

A hosted app's server uses the buyer's app subscription allowance while its
own developer organization pays Cloud infrastructure costs. The buyer can have
zero personal Cloud credits and no Eliza subscription.

Register a confidential app client for the intended `billingEnvironment` and
request explicit `identity` and `inference` consent through registered app
delegation. Use a developer API key scoped to the same app. Keep the client
secret, developer key, and delegated user token on the server.

```ts
const inference = cloud.appInference(appId, {
  clientId,
  clientSecret,
  developerApiKey,
});
const completion = await inference.createChatCompletion(
  {
    billingAccountId,
    productFamilyKey: "main",
    delegationToken,
    operationId: persistedOperationId,
  },
  { model, messages },
);
```

`streamChatCompletion` accepts the same inputs and returns the original
HTTP/SSE `Response`; check its status before reading the stream. Full model
messages are passed through. The registered client environment must match the
server's explicit `APP_INFERENCE_EXECUTION_ENVIRONMENT` (`test` or `live`). A
buyer-supplied environment header cannot select the execution authority.

The HTTP endpoint is
`POST /api/v1/apps/:appId/inference/chat/completions`. It takes standard Basic
client authentication, `X-App-Delegation`, and an independent
`X-Eliza-Developer-Authorization: Bearer <developer key>`. App account and
product family use `X-Eliza-Billing-Account-Id` and `X-Eliza-Product-Family`.
`Idempotency-Key` identifies one logical operation, not an HTTP attempt.
Legacy `X-App-Id` and affiliate markup headers are rejected.

Persist the operation ID before dispatch and reuse it only for the exact same
model request. Concurrent or repeated operations never dispatch again. A `409`
with `APP_INFERENCE_OUTCOME_UNKNOWN` means the original provider outcome is
pending reconciliation; do not create a fresh operation ID to retry that work.
`APP_INFERENCE_OPERATION_COMPLETE` means the operation already completed and
its original response should be read from the app's own durable operation
record. The Cloud funding ledger retains accounting receipts, not model text.

Both app allowance and developer cash are reserved atomically. Known provider
failure releases both once. Actual usage settles once and unused reservation
is released. Uncertain accepted usage keeps both reservations pending an
authoritative outcome. Usage exceeding the reservation is recorded explicitly
as uncollected overage under the existing Cloud funding settlement policy.
