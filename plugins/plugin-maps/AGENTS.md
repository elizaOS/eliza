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
  Preserve the per-owner bounds of 64 current places, 256 immutable operations,
  and 512 KiB serialized state. Resolve retained-key replay/conflict before
  rejecting new mutations at capacity; do not compact away idempotency history.
  Do not add another file store, scheduler, or identity graph.
- Native coordinates may be supplied by `@elizaos/capacitor-location`, but this
  package does not request device permissions or read device location itself.
- The plugin-local `/maps` view renders normalized results as a deterministic,
  provider-neutral schematic. It never fetches external tiles or invents
  attribution, ratings, availability, route alternatives, or geometry.
- `GoogleMapsAdapter` is the Google Places (New)/Routes integration. Its
  `api-key` and `managed` credential modes are explicit and never fall back
  into each other; managed mode sends only an opaque session token and
  connection id to the Cloud maps gateway and rejects endpoint overrides.
  Its request budget fails typed (`MAPS_BUDGET_EXHAUSTED`) before dispatch,
  its place-detail cache TTL must stay within Google's 30-day policy cap, and
  its legal attribution is exposed through the adapter-level `attribution`
  contract, never invented per result.
- Other commercial provider adapters and device-specific share/navigation
  launches belong to their owning connectors.

## Public surface

- `PlaceRef`, `RoutePlan`, and `SavedPlace` are validated normalized types.
- `MapsProviderAdapter` is the connector seam for place and route reads.
- Coordinate canonicalization must retain exact requested coordinates and an
  explicit `coordinateBinding` to the original coordinate place ID. Adapter
  identity by itself is not proof that a route endpoint is equivalent.
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
  `awaitingUserInput`; they never fabricate coordinates or places. Route forms
  offer the travel-mode select; place forms offer the result-limit filter.
- View reads use the authenticated `serverInteract` broker. The view must not
  call `savePlace()` directly; its save control hands a reviewable `MAPS_SAVE`
  request to chat so runtime receipt settlement remains authoritative.
- Chat surfaces render `[MAPSCARD]` markers (`src/card.ts`) for place, place
  list, route, handoff, and locate results. Card payloads carry display-safe
  fields only — no polylines, credentials, or provider internals — and the
  dashboard parser rejects handoff links outside `geo:` / Apple Maps /
  OpenStreetMap.
- `MAPS_SHARE` requires `confirm: true`; without it the action returns a
  confirmation choice and never emits a share URI. `useCurrentLocation`
  requests without coordinates return a locate card; coordinates are only ever
  supplied by the user's device through the chat surface.

## Commands

```bash
bun run --cwd plugins/plugin-maps test
bun run --cwd plugins/plugin-maps typecheck
bun run --cwd plugins/plugin-maps lint:check
bun run --cwd plugins/plugin-maps build
bun run --cwd packages/app audit:app
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
