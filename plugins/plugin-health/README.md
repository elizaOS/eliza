# `@elizaos/plugin-health`

Owns the health, sleep, circadian-regularity, and screen-time domain for
elizaOS. Extracted from `@elizaos/plugin-lifeops` so the same domain can serve
other apps without bringing the LifeOps runtime along.

## What this plugin owns

### Connectors

Six connector contributions registered against the LifeOps
`ConnectorRegistry`:

- `apple_health`
- `google_fit`
- `strava`
- `fitbit`
- `withings`
- `oura`

`src/connectors/index.ts` registers the `ConnectorContribution`s. The Wave-1
registry adapter returns typed disconnected / transport-error results while
the concrete OAuth pair/disconnect, credential storage, and provider readers
live under `src/health-bridge/`.

### Anchors

Four anchors registered against the `AnchorRegistry`:

- `wake.observed`
- `wake.confirmed`
- `bedtime.target`
- `nap.start`

Anchors back the `relative_to_anchor` trigger on
`ScheduledTask`s — for example, the `wake-up` pack fires
`relative_to_anchor("wake.confirmed", 0)` and the `sleep-recap` pack fires
`relative_to_anchor("wake.confirmed", 240)`.

### Bus families

Eight families registered against the `BusFamilyRegistry`
(`runtime.busFamilyRegistry`) and published on the `ActivitySignalBus`:

- `health.sleep.detected`
- `health.sleep.ended`
- `health.wake.observed`
- `health.wake.confirmed`
- `health.nap.detected`
- `health.bedtime.imminent`
- `health.regularity.changed`
- `health.workout.completed`

### Default packs

- `bedtime` — fires before the user's target bedtime.
- `wake-up` — fires when wake is observed/confirmed.
- `sleep-recap` — recap after sleep ends.

Each pack is a `ScheduledTask` (or set thereof) consuming the LifeOps spine.
`registerHealthDefaultPacks(runtime)` registers all three packs whenever the
runtime exposes a `defaultPackRegistry`; if it is absent the plugin logs a
single skip line and contributes nothing.

### Domain logic

- `src/sleep/` — sleep / circadian / regularity engines.
- `src/screen-time/` — type-only exports (`LifeOpsScreenTimePerAppUsage`, `LifeOpsScreenTimeSummaryPayload`); the aggregator lives in `plugins/plugin-lifeops/src/lifeops/service-mixin-screentime.ts` pending Wave-2 (W2-D) decoupling.
- `src/health-bridge/` — `detectHealthBackend` (HealthKit on darwin, Google
  Fit REST fallback), the Strava/Fitbit/Withings/Oura OAuth-bridged readers,
  the per-provider OAuth flow, and the `createLifeOpsHealth*` record
  factories. These are direct function exports, not HTTP routes.

## How LifeOps consumes plugin-health

LifeOps does not import internal modules. Consumption goes through:

1. **Connector contributions** — registered into LifeOps's
   `ConnectorRegistry` at boot via `registerHealthConnectors(runtime)`.
2. **Anchor contributions** — registered via `registerHealthAnchors(runtime)`
   into the `AnchorRegistry`.
3. **Bus families** — registered via `registerHealthBusFamilies(runtime)`
   into `BusFamilyRegistry` (`runtime.busFamilyRegistry`).
4. **Default packs** — registered via `registerHealthDefaultPacks(runtime)`.
5. **Public exports** — `detectHealthBackend`, sleep utilities, screen-time
   helpers exported from `@elizaos/plugin-health` and re-exported by
   `@elizaos/plugin-lifeops` only where the surface is part of the LifeOps
   public API.

If the LifeOps runtime registries are not available at boot, the plugin
logs a single skip line and contributes nothing. This is the soft-dependency
posture.

## Soft-dependency posture

`plugin-health` does not require `@elizaos/plugin-lifeops`. Other apps can
consume the plugin by registering their own implementations of:

- `ConnectorRegistry` (with `register` / `list` / `get` / `byCapability`)
- `AnchorRegistry` (with `register` / `list` / `get`)
- `BusFamilyRegistry` (with `register` / `list`)
- `DefaultPackRegistry` (with `register` / `list` / `get`)

The structural contracts the plugin builds against live in
`src/connectors/contract-types.ts`, `src/default-packs/contract-types.ts`,
and `src/contracts/health.ts`.

## Where to look next

- Plugin entry: `src/index.ts`.
- LifeOps consumption: `plugins/plugin-lifeops/README.md`.
- Frozen contracts: see `plugins/plugin-lifeops/AGENTS.md` for the connector /
  channel / transport contracts this plugin implements.
