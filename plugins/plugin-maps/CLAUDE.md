# @elizaos/plugin-maps

Provider-neutral maps domain for elizaOS agents: place lookup, route planning,
saved places, safe sharing, and navigation handoffs.

## Ownership and boundaries

- `MapsService` owns normalized maps behavior and adapter registration.
- Provider packages implement `MapsProviderAdapter`; this package never embeds
  provider credentials or provider-specific response shapes.
- Saved places use one agent-private canonical document per owner. Mutations
  must use the adapter's durable document CAS contract and preserve immutable
  operation-key history; never replace this with process-local locking alone.
  Do not add another file store, scheduler, or identity graph.
- Native coordinates may be supplied by `@elizaos/capacitor-location`, but this
  package does not request device permissions or read device location itself.
- Google Maps/Routes integration and rendered maps UI belong to later issues.

## Public surface

- `PlaceRef`, `RoutePlan`, and `SavedPlace` are validated normalized types.
- `MapsProviderAdapter` is the connector seam for place and route reads.
- `MAPS` is the umbrella action. `promoteSubactionsToActions` registers
  `MAPS_PLACE`, `MAPS_ROUTE`, `MAPS_SAVE`, `MAPS_SHARE`, and `MAPS_NAVIGATE`.
- Direct `MAPS` execution is read-only. Saves must use the promoted `MAPS_SAVE`
  action so runtime receipt settlement cannot be bypassed. Preserve promotion
  markers when changing per-action metadata.
- Idempotency replays return the original immutable operation plus current
  resource state. If a later update superseded it, return an unsuccessful
  historical result without an effect receipt; never claim that the prior
  desired state is current.
- Missing action inputs return a canonical form interaction and set
  `awaitingUserInput`; they never fabricate coordinates or places.

## Commands

```bash
bun run --cwd plugins/plugin-maps test
bun run --cwd plugins/plugin-maps typecheck
bun run --cwd plugins/plugin-maps lint:check
bun run --cwd plugins/plugin-maps build
```

## Verification

The provider-contract test drives a real HTTP adapter against the repository's
protocol-faithful fake upstream. Keep success, empty, validation, pagination,
rate-limit metadata, malformed/schema-drift responses, auth failures, network
failures, SSRF/DNS rebinding, redirects, response bounds, provider identity,
provider 4xx/5xx, opaque connection IDs, redaction, and read-policy coverage
intact. Saved-place tests must cover PGlite CAS persistence, owner scoping,
durable key history, receipt identity, current and historical replay, actual
runtime settlement, and forced datastore contention between independent
service instances.

Follow the root `AGENTS.md` and `CONTRIBUTING.md` evidence requirements.
