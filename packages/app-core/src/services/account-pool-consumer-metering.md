# Account-Pool Consumer Metering Contract

The account-pool broker owns linked-account selection, OAuth access-token
resolution, OAuth refresh, consumer-key storage, quota admission, and durable
usage records. It does not proxy Anthropic transport.

An external Anthropic-compatible protocol proxy owns HTTP transport. For each
public request, the proxy should:

1. Parse the Anthropic JSON request body, then call
   `authenticateAccountPoolConsumerRequest(headers, requestBody)`.
   Authentication conservatively reserves the serialized request bytes plus
   `max_tokens`, so configured quotas are enforced before upstream work.
2. If it returns `{ ok: false }`, return that 401/429 status and body directly
   with `Cache-Control: no-store`.
3. Use `upstreamHeaders` from the result when building the upstream request;
   both `x-api-key` and `Authorization` caller credentials are stripped.
4. Lease an upstream account through `/internal/account-pool/v1/lease`.
5. For non-streaming Anthropic responses, parse the response JSON and pass
   `extractAnthropicUsageFromJson(json)` plus the returned `admission` to
   `recordAccountPoolConsumerUsage`.
6. For streaming responses, pipe the upstream byte stream through
   `createAnthropicSseUsageMeter(onUsage)`, then record the observed usage with
   the returned `admission`. The transform enqueues the original bytes unchanged
   and only observes `message_start` / `message_delta` data events for metering.
   Always call the meter's idempotent `finalizeUsage()` from the proxy's `finally`
   block so client disconnects and upstream stream errors persist partial usage
   and release the reservation.

Public consumer auth is opt-in through
`ELIZA_ACCOUNT_POOL_CONSUMER_AUTH_ENABLED=1`. When it is unset, the helper
returns legacy mode so existing localhost/direct no-key integrations keep their
current behavior.

Consumer key management is admin-only under the existing loopback bearer-gated
broker API:

- `GET /internal/account-pool/v1/consumer-keys`
- `POST /internal/account-pool/v1/consumer-keys`
- `PATCH /internal/account-pool/v1/consumer-keys/:id`
- `POST /internal/account-pool/v1/consumer-keys/:id/rotate`
- `GET /internal/account-pool/v1/usage?consumerId=&startMs=&endMs=`

Plaintext consumer keys are returned only by create and rotate. The state store
persists a SHA-256 digest plus public metadata.
