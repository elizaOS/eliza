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

## Persistence and privacy

Saved places are stored in one deterministic, agent-private canonical document
per owner. The document uses the runtime adapter's compare-and-swap contract to
atomically bind current resources to an immutable operation-key ledger. Each
committed mutation receives a unique commit ID and timestamp; retries replay the
original result, while reuse of a key for different input is permanently
rejected. Provider credentials are never placed in URLs, action results, logs,
diagnostics, or saved-place records.

## Adapter contract

Adapters return normalized values only. Untrusted provider responses are
validated and bound to the selected adapter identity before reaching callers.
The HTTP adapter accepts one public HTTPS origin, uses core's DNS-pinned SSRF
guard, rejects redirects, bounds timeout and response bytes, and classifies HTTP
status before optionally parsing an error envelope. A 429 retains
`retryAfterMs`; expired and revoked credentials remain distinct auth failures.

The generic HTTP protocol is:

- `GET /places/search?query=…&cursor=…&limit=…`
- `GET /places/:providerPlaceId`
- `POST /routes`

No Google adapter or rendered map UI is included here.

## Commands

```bash
bun run --cwd plugins/plugin-maps test
bun run --cwd plugins/plugin-maps typecheck
bun run --cwd plugins/plugin-maps lint:check
bun run --cwd plugins/plugin-maps build
```
