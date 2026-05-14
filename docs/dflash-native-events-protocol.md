# DFlash Native Accept/Reject Event Protocol

Status: design — JS side implemented behind a feature flag; C-side emission is
pending the next merge of the `buun-llama-cpp` fork.

This document specifies the wire format the elizaOS JS runtime expects from the
`llama-server` fork when reporting DFlash speculative-decoding decisions. The
previous integration synthesized `accept` events from each SSE text chunk on
the client, so the runtime never saw the true drafter/verifier ratio or the
exact indices the verifier rejected. With this protocol every speculation
decision is reported in-band on the existing OpenAI-compatible SSE stream so
the rollback / autotune / bench harnesses can consume real data.

The protocol is **additive**. Servers that do not emit the `dflash` field
keep working unchanged, and clients that do not read it keep working
unchanged. The JS side gates consumption behind two switches; the legacy
synthesis path is the default in every shipped build.

## 1. Capability advertisement

The server reports support on `GET /health`:

```json
{
  "status": "ok",
  "capabilities": {
    "dflashNativeEvents": true
  }
}
```

- The field MUST be present at exactly that path. Clients use a single probe
  per spawned-server lifetime and cache the result.
- Any value other than the boolean `true` (absent, `false`, non-JSON, HTTP
  non-2xx, network error within 2 s) MUST be treated as "not advertised" and
  the client falls back to legacy synthesis.
- Forks MAY add other fields to `capabilities`; clients ignore unknown keys.

## 2. SSE chunk extension

Native events ride on the standard OpenAI-compatible `POST /v1/chat/completions`
SSE stream. Each chunk that wraps a speculation decision adds a top-level
`dflash` field alongside the existing `choices` array:

```json
{
  "choices": [{ "delta": { "content": "Hel" } }],
  "dflash": [
    { "kind": "speculate-start", "round": 7, "ts": 1234567 },
    { "kind": "accept", "drafted": [10, 11, 12], "accepted": [10, 11], "ts": 1234568 }
  ]
}
```

- `dflash` MAY be a single event object or an array of events. Clients accept
  both.
- The standard `choices[].delta.content` is still emitted for the accepted
  tokens. Native events are additive metadata, never a replacement for the
  text delta.
- `ts` is a server-side monotonic timestamp in milliseconds. Clients only use
  it for relative ordering; the absolute clock domain is unspecified.

## 3. Event kinds

All events share `{ kind, ts }`. Token-id fields use the server-side
vocabulary id (the `int32` produced by `llama_token`), not byte offsets.
Token indices in `rejectRange` are positions in the target output stream
(0-based, inclusive on both ends, same domain as the legacy
`verifier.rejected` extension this protocol supersedes).

### 3.1 `accept`

Emitted exactly once per draft batch the verifier processes. `drafted` lists
the token ids the drafter proposed in target output order; `accepted` is the
prefix the verifier accepted (`accepted.length <= drafted.length`; empty
means everything was rejected). When the verifier accepts every drafted token
plus the verifier's own bonus token, the bonus token is NOT included in this
event — it appears in a subsequent `accept` event with `drafted = [bonus]`,
`accepted = [bonus]`, so the JS side does not need to special-case the bonus.

```json
{
  "kind": "accept",
  "drafted": [10, 11, 12],
  "accepted": [10, 11],
  "ts": 1234568
}
```

### 3.2 `reject`

Emitted when the verifier rejects a contiguous span of already-streamed
drafted tokens and replaces position `from` with `correctedToken`. The span
is inclusive on both ends. Subsequent tokens that need to be re-emitted are
sent in standard `choices[].delta.content` deltas; the JS side rewinds its
position cursor to `from`.

```json
{
  "kind": "reject",
  "drafted": [9, 10, 11],
  "rejectRange": [10, 11],
  "correctedToken": 42,
  "ts": 1234569
}
```

This event supersedes the legacy `{ "verifier": { "rejected": [a, b] } }`
chunk shape. Servers MAY emit both for one merge window; clients dedupe by
preferring `dflash.reject` when present.

### 3.3 `speculate-start` / `speculate-end`

Bracket a single speculation round so the JS side can group events for
per-round diagnostics. `round` is a server-assigned monotonically increasing
integer per request. `totalDrafted` / `totalAccepted` on `speculate-end`
report the sum across all `accept` events in the round (so a client that
dropped a chunk can still reconcile).

```json
{ "kind": "speculate-start", "round": 7, "ts": 1234567 }
{ "kind": "speculate-end", "round": 7, "totalDrafted": 6, "totalAccepted": 5, "ts": 1234600 }
```

A round MAY omit `speculate-start` / `speculate-end` markers; clients treat
events outside any round as belonging to a virtual `round = -1` bucket and
do not discard them. A round MAY span multiple SSE chunks; clients do not
assume one round per chunk.

## 4. Backward compatibility

- Servers that never emit `dflash` are valid. The JS side falls back to
  synthesizing accept events from text deltas — the behavior shipped today.
- Servers that emit `dflash` to clients that do not read it remain valid.
  Existing clients ignore unknown top-level SSE fields.
- The legacy `verifier.rejected` chunk shape is still parsed; servers MAY
  emit it during a transition merge. Clients prefer `dflash.reject` when
  both are present in the same chunk.
- `/health` MUST remain a 200 with at minimum `{ "status": "ok" }` when the
  capability is absent. The capability field is additive.

## 5. C-side reference sketch

These notes describe how to wire emission inside the `buun-llama-cpp` fork.
The JS-side agent does NOT edit the C code — the merge agent owns the fork.
Paths reference the upstream layout.

- **Capability flag** — `tools/server/server.cpp` builds the `/health`
  response from `server_state::health_to_json`. Add a `capabilities` object
  there and set `dflashNativeEvents = true` only when the binary was built
  with the native event emitter enabled (e.g. `LLAMA_DFLASH_NATIVE_EVENTS`
  compile flag).
- **Emission point** — `tools/server/server-task.cpp` is where the prior
  audit located the SSE chunk emission for completions. The DFlash
  speculative-decoding path calls into `llama_speculative_*` and observes
  the drafter's batch + the verifier's accept count per round. Build the
  `dflash` field there and merge it into the same `json` payload the chunk
  writer serializes. Emit `speculate-start` immediately before issuing the
  drafter batch; emit `accept` (and `reject` when a span is rolled back)
  immediately after the verifier returns; emit `speculate-end` after the
  drafter loop exits for the round.
- **Timestamp** — use `ggml_time_us() / 1000` for `ts` so the value is
  monotonic and cheap.
- **Backward compat** — the existing `verifier.rejected` emission can stay
  during the transition merge; the JS side prefers `dflash.reject` when
  both are present.

## 6. Versioning

This protocol is version 1. Forward-compatible additions (new event kinds,
new fields on existing events) MUST be ignorable by old clients. Breaking
changes will gate behind a new capability flag
(`capabilities.dflashNativeEventsV2`) so old clients remain on v1 until
explicitly upgraded.
