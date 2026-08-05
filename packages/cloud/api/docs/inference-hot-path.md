# Inference hot path

Refs: #9899, #16917, and #16925.

## Contract

An admitted Cloudflare Worker token/model request must not query or mutate
Postgres, connect to Railway Redis, or wait for an accounting write before
dispatching the provider request. This contract covers `/v1/chat`,
`/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/embeddings`,
shared-agent model turns, the internal Eliza model turn used by a voice session,
direct TTS/STT, and image, video, music, and SFX generation. Voice cloning and
other stateful mutation/job endpoints retain their own reservation semantics.

The synchronous Worker path is:

1. Cloudflare-native ingress rate limit.
2. Cloudflare KV cache reads for authorization, model pricing, organization
   balance revision, affiliate attribution, and app policy as applicable.
3. A per-organization Durable Object call that serializes the exact endpoint
   rate decision.
4. A call to the same object that durably leases the estimated charge.
5. A final call that durably marks provider-dispatch intent immediately before
   the provider invocation.
6. Provider dispatch.

A warm billed request therefore makes three serial Durable Object calls before
the provider. Keeping rate, money, and dispatch-intent transitions explicit
makes the crash states independently testable. The repository benchmark measures
those calls in-process; it is a regression tripwire, not evidence of deployed
cross-isolate or regional network latency.

The provider response, including direct provider-error responses, is not delayed
by database accounting. Post-provider settlement, cache projection, analytics,
and payout delivery run under `executionCtx.waitUntil`. A Durable Object alarm
recovers an expired dispatched monetary lease if response-side settlement
disappears.

This contract applies to the listed generative routes in the inference Worker.
Non-Worker tools and stateful job endpoints retain synchronous compatibility,
but a covered Worker route must never fall back to that path. Missing or
unavailable cache state produces a retryable 503 and starts asynchronous
hydration; insufficient cached balance produces 402; a rate denial produces
429. Content-safety checks and object storage remain synchronous where the
returned artifact depends on them.

## Why Railway Redis is not on this path

Railway Redis remains useful to services running inside Railway's private
network. A Cloudflare Worker would reach it across providers using a public TCP
connection, adding connection setup, latency, egress, and another availability
dependency to every model request.

The covered token/model routes therefore bypass the legacy Railway Redis
deployment guard. Their ingress limits use Cloudflare Rate Limiting bindings,
and exact organization limits use the same per-organization Durable Object that
owns monetary leases. General API and excluded media/job routes can continue
using Railway Redis without making it a prerequisite for an LLM request.

Moving the entire inference control plane into Railway would change this
tradeoff. In that topology, Redis with atomic scripts could own exact counters
and short-lived leases. Mixing a Cloudflare Worker with Railway Redis is not the
selected production architecture.

## State ownership

| State | Synchronous owner | Durable/source-of-truth owner | Consistency |
| --- | --- | --- | --- |
| API-key and Steward-session authorization | One combined Cloudflare KV decision | Postgres/Steward | 60s physical bound; active entries refresh after 30s under `waitUntil` |
| Moderation decision | Cloudflare KV auth context | Postgres | Invalidated on lifecycle changes; bounded staleness |
| Model pricing | Cloudflare KV | Pricing tables | Revisioned cache; cold requests warm and retry |
| Affiliate attribution | Cloudflare KV | Postgres | Immutable snapshot per admitted request |
| App policy | Cloudflare KV | Postgres | Immutable snapshot per admitted request |
| Organization balance hint | Cloudflare KV | Postgres | Revisioned, lower-only admission hint |
| Organization endpoint rate | Durable Object | Durable Object | Strongly ordered per organization |
| In-flight estimated spend | Durable Object | Durable Object | Strongly ordered per organization |
| Anonymous identity and quota | Durable Object | Postgres projection | Strongly ordered counters; async revisioned mirror |
| Token/model credits, transactions, and payouts | none before provider | Postgres | Written after provider; idempotent recovery |

Eventual consistency is acceptable for metadata and projections whose revision,
TTL, and invalidation rules are explicit. It is not acceptable for concurrent
rate increments or admission against in-flight spend. Those decisions are
serialized in a Durable Object instead of implemented as read-modify-write
operations in KV. Post-provider credit debits and external balance mutations
remain transactional in Postgres and publish monotonic cache revisions.

## Authorization and cold-cache behavior

`INFERENCE_AUTH_CACHE_ENABLED` is enabled in staging and production. Warm API
keys and Steward sessions perform one combined remote decision read containing
identity, organization, and moderation state. The physical TTL is 60 seconds;
an active entry older than 30 seconds is served immediately while an
authoritative refresh runs under `waitUntil`. This bounds a lost or
eventually-consistent invalidation to the same one-minute horizon already used
by moderation decisions without joining Postgres or Steward to dispatch.

The implementation accepts positive cache entries only for fully authorized
credentials. API-key entries are keyed by the full credential hash. Steward
JWTs use an in-isolate verification memo after the combined decision read, so
the distributed JWT memo does not add a second cache lookup. Wallet signatures
remain outside the cache-only Worker path because their timestamped proof
cannot safely be replayed as asynchronous hydration.

On a Worker cache miss:

- the request receives a retryable warming response;
- the authoritative lookup is registered with `waitUntil`;
- concurrent hydration is single-flight by identity; and
- no provider request starts until a later request observes the populated
  cache.

When the gate is enabled, cache errors never fabricate authorization and never
join a Postgres fallback to the request promise. Invalidation is only a cache
hygiene mechanism; it is not the authorization revocation boundary.

Pricing, affiliate attribution, app policy, balance, and uninitialized Durable
Objects follow the same fail-closed warming pattern. The first request may warm
state; it does not purchase lower latency by bypassing a correctness check.

### Flag scope: the IAC vs. the shared-agent scope cache

`INFERENCE_AUTH_CACHE_ENABLED` governs ONLY the inference auth-context (IAC)
entries above (`iac:auth:*`, `iac:session-auth:*`). "Positive KV entries are
ignored while the flag is off" is an IAC statement; it does not describe the
shared-agent chat surface.

The shared-agent model routes (`POST .../agents/:id/stream|bridge` and
`.../api/conversations/:id/messages[/stream]`) are authorized by a distinct,
flag-independent positive cache: the shared-agent SCOPE entry
(`shared-agent-scope:*`, 30s base TTL, credential-revalidated sliding refresh
capped at 5 minutes). It is bounded rather than gated because every hit re-runs
a per-request credential gate before the cached scope is served:

- API-key hits re-check the revoke-invalidated key-validation entry and the
  org match; key revocation fails closed (unconfirmed invalidation throws).
- Session hits re-verify the steward JWT, require subject equality with the
  entry, and consult the lifecycle-invalidated `user:steward:<id>` entry for
  an active user in the cached org's active organization. Ban, deactivate,
  and org-detach evict that entry, so a session hit deauthorizes on the next
  turn after the mutation; a miss fails closed into re-hydration.

Residual exposure bound: an authorization-relevant mutation that evicts no
cache entry (none is currently known for the session path; for the API-key
path a user-level ban does not revoke the key or its validation entry) is
bounded by the 30s idle TTL and the 5-minute sliding-refresh cap, after which
the entry must re-hydrate through the authoritative gate. Cache-only misses
never authorize — they warm under `waitUntil` and return a retryable 503.

## Organization admission protocol

`InferenceAdmissionGate` is addressed by organization ID. A lease request
contains:

- request and organization identity;
- the cached balance and monotonic balance revision;
- an estimated charge; and
- a versioned recovery snapshot that pins the only allowed accounting lane.

The object durably:

1. applies only safe balance revisions;
2. subtracts all active and expired monetary holds;
3. rejects an unaffordable request;
4. stores the lease and its recovery snapshot before replying;
5. persists provider-dispatch intent immediately before invocation; and
6. schedules recovery atomically with every persisted active-lease state.

Duplicate request IDs are idempotent only when their immutable lease facts
match. A higher but stale balance hint cannot restore capacity. An expired lease
that was never dispatched releases its hold. An expired dispatched lease is
claimed for recovery and retains its hold until the pinned accounting lane
finishes. The exact object lease replaces the KV optimistic lane's minimum
balance cushion: an organization below that compatibility threshold is admitted
whenever its cached balance can cover this request, including exact equality.

After provider work, exactly one lane settles the lease:

- **organization credits:** deterministic direct debit keyed by organization
  and request;
- **affiliate inference:** atomic direct debit plus payout-outbox insertion,
  using the pinned affiliate and payout identity; or
- **monetized app:** server-generated app reservation using the same estimate
  and request identity, followed by reconciliation to actual usage.

The response-side task debits/reconciles Postgres, refreshes projections, and
then tells the Durable Object the balance-backed amount, conservative
gate-consumed amount, and authoritative post-accounting balance revision. If
that task is lost, the alarm replays the same idempotent lane at the conservative
estimate. The object clears a dispatched lease only with request-specific
proof. Any uncollected amount remains gate debt and cannot be resurrected by a
delayed balance snapshot.

There is no pre-provider database ledger insert, KV pending-charge write, or
background reservation. The durable lease itself is the write-ahead record.
This avoids switching accounting identities between normal settlement and
recovery, which could otherwise double charge a request after an ambiguous
acknowledgement.

## Anonymous chat

Anonymous chat uses a separate Durable Object keyed by a hash of the opaque
session token. It owns session expiry, moderation state, lifetime quota, hourly
quota, active leases, and idempotent commit/refund.

A cold object returns 503 while Postgres state hydrates under `waitUntil`.
Admitted and refunded counter snapshots mirror to Postgres asynchronously with
monotonic revisions. The Durable Object remains authoritative for live quota,
so a delayed projection cannot grant extra messages.

## Failure semantics

- Missing/invalid cache or binding: 503; never synchronous SQL fallback.
- Cold cache or Durable Object: 503 plus asynchronous hydration.
- Cached or exact insufficient balance: 402 before provider dispatch.
- Exact endpoint or ingress limit: 429 before provider dispatch.
- Provider failure known to be uncharged: release/reconcile with zero according
  to the route's provider-outcome classifier.
- Ambiguous or billable provider outcome: conservatively settle.
- Accounting failure after provider: keep the lease, invalidate permissive
  balance projections, and retry through the same idempotent identity.
- Expired undispatched lease: release the hold without charging.
- Expired dispatched or recovering lease: keep the hold until alarm recovery
  returns an authoritative balance revision.

These rules prefer an explicit retry over hidden latency or free inference.

## Deployment configuration

Staging and production require:

- `CACHE_KV`;
- `GLOBAL_RATE_LIMITER`, `CHAT_ROUTE_RATE_LIMITER`, and
  `DASHBOARD_CHAT_ROUTE_RATE_LIMITER`;
- `INFERENCE_ADMISSION_GATES`;
- `ANONYMOUS_CHAT_GATES`;
- `INFERENCE_OPTIMISTIC_BILLING="true"`;
- `INFERENCE_DEFERRED_ADMISSION="true"`; and
- `INFERENCE_HOT_PATH_CACHES="true"`.

`INFERENCE_AUTH_CACHE_ENABLED="true"` and
`THIN_INFERENCE_ENTRY_ENABLED="true"` are enabled in staging and production.
The thin entry lazily evaluates only the matched generative route module rather
than the monolithic API router. Either flag remains an independent rollback
control.

`INFERENCE_BILLING_LEDGER` still selects the compatibility ledger for
non-Worker callers and sweep migration support. It does not add a ledger write
before provider dispatch on the Worker path.

`REDIS_RATE_LIMITING` continues to govern general API routes. The covered
token/model routes use Cloudflare-native bindings and do not require
`REDIS_URL`.

## Verification

The production contract is protected at three layers:

1. Route tripwire tests install database seams that throw if chat,
   completions, messages, responses, embeddings, shared-agent, voice, or media
   generation touches them before provider dispatch.
   These tripwires are what enforce the zero pre-provider Postgres, Redis,
   ledger, reservation, and payout guarantee.
2. Admission tests assert the only warm pre-dispatch write is the Durable
   Object lease, including organization, affiliate, app, anonymous, cold-cache,
   concurrency, and crash-recovery cases.
3. An in-process benchmark measures the serial rate, lease, and dispatch
   transitions against the admission object in isolation. It is a latency
   regression tripwire only; the zero-operation guarantee lives in the route
   tripwires above, and deployed Worker-to-Durable-Object latency must be
   measured separately in the target Cloudflare topology.

Migration tests apply the accounting schema to PGlite. Money tests exercise
idempotent direct debits, app reconciliation, affiliate payout outbox replay,
alarm-versus-late-settlement races, and monotonic balance revisions.
