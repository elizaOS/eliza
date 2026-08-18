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

Saved places are stored through `AgentRuntime.createMemory` in the
`maps_saved_places` table and are scoped to both agent and owner entity. Stable
resource IDs and serialized writes make retries and concurrent duplicate saves
idempotent. Provider credentials are never placed in URLs, action results,
logs, diagnostics, or saved-place records.

## Adapter contract

Adapters return normalized values only. Untrusted provider responses are
validated before reaching the service. Provider failures use `MapsProviderError`
with typed codes and optional retry metadata. A 429 response retains
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
