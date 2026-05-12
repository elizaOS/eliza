# Eliza-1 DFlash Verify-Event Wire Format (L1)

Status: design — wire format frozen; C-side emission patch in
`packages/inference/llama.cpp/.patches/dflash-verify-events.patch`; JS-side
parsing and metrics scrape implemented in `dflash-server.ts` behind a
feature flag.

This document specifies the **verify-step** event that the
`buun-llama-cpp` fork's `llama-server` MAY emit on each speculative
verification step. It is the L1 ledger item ("Wire native DFlash
accept/reject events end-to-end") and extends — does NOT replace — the
existing `dflash` discriminated-union events documented in
[`dflash-native-events-protocol.md`](./dflash-native-events-protocol.md).

The JS runtime today synthesises `VerifierStreamEvent { kind: "accept" }`
from each OpenAI SSE text delta. That gives the voice loop a usable token
cursor but the indices the verifier actually rejected, the drafter's true
token-batch, and per-draft logprobs are all thrown away. The
`dflash-verify` event closes that gap by emitting the verify-step record
verbatim on the SSE stream.

## 1. Capability advertisement

Same `GET /health` mechanism as the discriminated-union protocol:

```json
{
  "status": "ok",
  "capabilities": {
    "dflashNativeEvents": true,
    "dflashVerifyEvents": true
  }
}
```

- `dflashVerifyEvents` is **additive** to `dflashNativeEvents`. A server
  MAY advertise the union events without the verify-step event (older
  emitter) but MUST NOT advertise verify-events without the union events
  (every verify-step transitively produces a `speculate-start`/`accept`
  pair, so missing the union would be a bug).
- Clients tolerate `dflashVerifyEvents` missing — they fall back to the
  union-event accept/reject counters when the verify event is absent.

## 2. SSE chunk extension

Native verify events ride on the same SSE chunk as the existing OpenAI
`choices` array and the `dflash` discriminated-union events. A chunk MAY
carry one or more verify events on a top-level `dflashVerify` field:

```json
{
  "choices": [{ "delta": { "content": "Hel" } }],
  "dflash": [
    { "kind": "speculate-start", "round": 7, "ts": 1234567 },
    { "kind": "accept", "drafted": [10, 11, 12], "accepted": [10, 11], "ts": 1234568 }
  ],
  "dflashVerify": {
    "kind": "dflash-verify",
    "drafted_tokens": [
      { "id": 10, "logprob": -0.12 },
      { "id": 11, "logprob": -0.41 },
      { "id": 12, "logprob": -1.87 }
    ],
    "accept_count": 2,
    "reject_index": 2,
    "correction_token": { "id": 42, "logprob": -0.31 },
    "post_correction_tokens": [
      { "id": 99, "logprob": -0.05 }
    ],
    "ts": 1234568
  }
}
```

- The `dflashVerify` field MAY be a single object or an array of objects;
  clients accept both.
- `dflashVerify` is **always emitted alongside** the union `accept` /
  `reject` events for the same step (the union events carry token-id
  histories that older clients already consume; the verify event carries
  the richer logprob metadata).
- Standard `choices[].delta.content` is unchanged. Verify events are
  metadata-only.

## 3. Verify-event schema

```typescript
interface DflashVerifyEvent {
  kind: "dflash-verify";
  /**
   * The drafter's proposed batch this step, in target-output order.
   * `id` is the llama vocabulary id; `logprob` is the drafter's
   * (target-evaluated) log-probability at that position.
   */
  drafted_tokens: Array<{ id: number; logprob: number }>;
  /** How many of `drafted_tokens` the verifier accepted as a prefix. */
  accept_count: number;
  /**
   * 0-based index of the first rejected position in `drafted_tokens`,
   * or `null` when everything was accepted. When non-null, equals
   * `accept_count` (the prefix ends one before the first rejection).
   */
  reject_index: number | null;
  /**
   * The verifier's replacement token at `reject_index`. `null` when
   * `reject_index === null` (nothing to correct).
   */
  correction_token: { id: number; logprob: number } | null;
  /**
   * Verifier-emitted tokens AFTER the correction (when the verifier
   * sampled a bonus token, or the next pre-draft tokens land on the same
   * SSE chunk). Empty array is the common case.
   */
  post_correction_tokens: Array<{ id: number; logprob: number }>;
  /** Server monotonic timestamp in ms (`ggml_time_us() / 1000`). */
  ts: number;
}
```

### Invariants

- `accept_count >= 0`.
- `accept_count <= drafted_tokens.length`.
- `reject_index === null` iff `accept_count === drafted_tokens.length`.
- When non-null, `reject_index === accept_count` (DFlash verifier rejects
  a single contiguous suffix; a reject in the middle of a prefix is
  represented as a rejection at the first mismatched position).
- `correction_token` is non-null iff `reject_index` is non-null.
- `post_correction_tokens.length >= 0`. Bounded by `n_predict` per step.
- `logprob` is finite or `-Infinity`. NaN MUST be omitted (client
  validators drop the event).

## 4. Justification for shape

- **Why a single `dflash-verify` kind instead of two events?** The
  drafter batch + verifier decision are produced atomically in one
  C-side verify call. Splitting them across events would force clients
  to reassemble state from a stream; carrying both fields in one event
  is the natural unit of work.
- **Why `accept_count` AND `reject_index`?** They are derivable from
  each other but having both makes the JS consumer trivially fast
  (no branching to compute the cursor advance). The redundancy also
  makes malformed events catch-able by a single invariant check.
- **Why per-token logprobs?** Two consumers depend on this:
  - The DSPy autotuner uses drafter-vs-verifier logprob gaps as a
    signal that the drafter is drifting (cheap heuristic alongside
    `acceptanceRate`).
  - The voice rollback heuristic (Q1) uses the correction token's
    logprob to decide whether to retract phonemes spoken from the
    rejected suffix or to insert a brief mid-phrase pause. Low-confidence
    corrections (`logprob > -3`) skip retraction; high-confidence
    corrections (`logprob < -1`) trigger immediate scheduler rollback.
- **Why `post_correction_tokens`?** The verifier in some configurations
  decodes one or more tokens past the correction within the same SSE
  flush window. Carrying them in the same verify event lets the client
  advance its token cursor in a single transaction.

## 5. Metrics scrape

The `/metrics` Prometheus endpoint exposes per-process counters
alongside the verify event stream. Item L1 specifically asks for these
to be scrapeable for cross-checking the SSE-derived stats:

| Metric                                       | Type    | Source                                              |
| -------------------------------------------- | ------- | --------------------------------------------------- |
| `llamacpp:n_drafted_total`                   | counter | Existing — every drafted token                      |
| `llamacpp:n_drafted_accepted_total`          | counter | Existing — verifier-accepted prefix tokens          |
| `llamacpp:n_drafted_rejected_total`          | counter | **NEW** — drafted tokens past the accepted prefix   |
| `llamacpp:n_verify_steps_total`              | counter | **NEW** — distinct `dflash-verify` events emitted   |

The JS side scrapes deltas across the request lifetime in
`generateWithUsage()` and reports them as
`DflashGenerateResult.dflashRawMetrics`:

```typescript
dflashRawMetrics: {
  rejectedTokens: number;   // delta of n_drafted_rejected_total
  verifySteps: number;      // delta of n_verify_steps_total
  acceptanceRate: number | null;  // accepted / drafted; null when drafted=0
}
```

When the binary predates the L1 emitter the two NEW metrics are absent
and `dflashRawMetrics` is `undefined` on the result.

## 6. Versioning

This is `dflashVerifyEvents` version 1. Forward-compatible additions
(new optional fields) MUST be ignorable. Breaking changes will gate
behind `capabilities.dflashVerifyEventsV2`.

## 7. Feature flags

Both flags must be true for the JS side to consume verify events:

1. **Bundle opt-in** — `runtime.optimizations.useNativeDflashEvents` on
   the catalog model (defaults to `false`).
2. **Runtime capability probe** — `/health` returns
   `capabilities.dflashVerifyEvents === true`. Cached per spawned-server
   lifetime.

If either is false, verify events on the stream are silently ignored
and the legacy synthesised accept-only path runs unchanged — the
behaviour shipped today, byte-identical on the wire.
