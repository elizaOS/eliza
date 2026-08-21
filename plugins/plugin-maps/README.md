# @elizaos/plugin-maps

Provider-neutral maps capabilities for Eliza agents. The package normalizes
place search, route planning, durable saved places, share links, and navigation
handoffs without selecting a commercial maps provider.

## Surface

- `MapsService` — registers provider adapters and owns maps operations.
- `MapsProviderAdapter` — stable seam implemented by provider packages.
- `JsonMapsHttpAdapter` — normalized HTTP protocol adapter useful for managed
  bridges and deterministic contract testing; it accepts an injected endpoint
  and credential rather than naming a provider.
- `PlaceRef`, `RoutePlan`, `SavedPlace` — validated public DTOs.
- `MAPS` plus promoted `MAPS_PLACE`, `MAPS_ROUTE`, `MAPS_SAVE`, `MAPS_SHARE`,
  and `MAPS_NAVIGATE` actions.
- Plugin-local `/maps` routed view with responsive search, filtering, result
  list, provider-neutral coordinate schematic, place details, and
  provider-returned route choices.
- Authenticated view capabilities for place search, detail, and route reads.
  Persistent saves remain exclusive to receipt-enforced `MAPS_SAVE`.

## Persistence and privacy

Saved places are stored in one deterministic, agent-private canonical document
per owner. The document uses the runtime adapter's compare-and-swap contract to
atomically bind current resources to an immutable operation-key ledger. Each
committed mutation receives a unique commit ID and timestamp; retries replay the
original result and separately report whether a later mutation superseded it.
Current-state retries use explicit no-op receipts. Historical replays expose the
current resource as a typed unsuccessful action result without an effect
receipt, so they never claim that the old desired state was re-committed. Reuse
of a key for different input is permanently rejected. Provider credentials are
never placed in URLs, action results, logs, diagnostics, or saved-place records.
Each owner is bounded to 64 current places, 256 immutable operations, and a
512 KiB serialized state document. Replays are resolved before quota checks;
new mutations reject with `MAPS_STORAGE_LIMIT` before CAS at boundary plus one,
so a full owner remains readable and every retained key keeps permanent replay
and conflict semantics.

The `MAPS` umbrella is read-only at execution time. Persistent saves must route
through `MAPS_SAVE`, whose write, idempotency, and receipt-required tags keep
runtime settlement enforcement attached to every mutation.

## Adapter contract

Adapters return normalized values only. Untrusted provider responses are
validated and bound to the selected adapter identity before reaching callers.
The HTTP adapter accepts one public HTTPS origin, uses core's DNS-pinned SSRF
guard, rejects redirects, bounds timeout and response bytes, and classifies HTTP
status before optionally parsing an error envelope. A 429 retains
`retryAfterMs`; expired and revoked credentials remain distinct auth failures.
One deadline spans headers and all body reads, cancellation is non-blocking
teardown, and an HTTP error status remains authoritative if its optional
diagnostic body stalls or exceeds the byte limit. Provider canonicalization of
a coordinate endpoint must retain exact coordinates and an explicit
`coordinateBinding` to the original coordinate place ID; provider identity
alone never authorizes endpoint substitution.

The generic HTTP protocol is:

- `GET /places/search?query=…&cursor=…&limit=…`
- `GET /places/:providerPlaceId`
- `POST /routes`

No Google adapter, external tile request, or provider credential is included.
The view identifies the provider IDs present in normalized DTOs and explicitly
degrades when route geometry or provider legal-attribution metadata is absent;
it does not fabricate either.

## Commands

```bash
bun run --cwd plugins/plugin-maps test
bun run --cwd plugins/plugin-maps typecheck
bun run --cwd plugins/plugin-maps lint:check
bun run --cwd plugins/plugin-maps build
```
