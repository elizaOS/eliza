# `@elizaos/plugin-health`

Owns the health, sleep, circadian-regularity, and screen-time domain for
elizaOS. Extracted from `@elizaos/app-lifeops` so the same domain can serve
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

Each pair-and-disconnect flow, dispatch surface, and credential boundary
lives under `src/connectors/`. Connectors return typed `DispatchResult` —
not booleans.

### Anchors

Four anchors registered against the `AnchorRegistry`:

- `wake.observed`
- `wake.confirmed`
- `bedtime.target`
- `nap.start`

Anchors back the `relative_to_anchor` trigger on
`ScheduledTask`s — for example, `morning-brief` fires `relative_to_anchor`
on `wake.confirmed` with a small offset.

### Bus families

Eight families registered against the `FamilyRegistry` and published on the
`ActivitySignalBus`:

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
The plugin registers them lazily — only when at least one health connector
pairs.

### Domain logic

- `src/sleep/` — sleep / circadian / regularity engines.
- `src/screen-time/` — screen-time aggregation.
- `src/health-bridge/` — proxied surfaces consumed by LifeOps
  (`/api/lifeops/health/summary`, `/api/lifeops/health/sync`).

## How LifeOps consumes plugin-health

LifeOps does not import internal modules. Consumption goes through:

1. **Connector contributions** — registered into LifeOps's
   `ConnectorRegistry` at boot via `registerHealthConnectors(runtime)`.
2. **Anchor contributions** — registered via `registerHealthAnchors(runtime)`
   into the `AnchorRegistry`.
3. **Bus families** — registered via `registerHealthBusFamilies(runtime)`
   into `FamilyRegistry`.
4. **Default packs** — registered via `registerHealthDefaultPacks(runtime)`.
5. **Public exports** — `detectHealthBackend`, sleep utilities, screen-time
   helpers exported from `@elizaos/plugin-health` and re-exported by
   `app-lifeops` only where the surface is part of the LifeOps public API.

If the LifeOps runtime registries are not available at boot, the plugin
logs a single skip line and contributes nothing. This is the soft-dependency
posture.

## Soft-dependency posture

`plugin-health` does not require `app-lifeops`. Other apps can consume the
plugin by registering their own implementations of:

- `ConnectorRegistry` (with `register` / `get` / `list`)
- `AnchorRegistry` (with `register` / `resolve`)
- `FamilyRegistry` (with `register`)
- A `ScheduledTaskRunner` that accepts the default packs

The contracts the plugin builds against live in `src/contracts/health.ts`
and `plugins/app-lifeops/docs/audit/wave1-interfaces.md` §1, §3.

## Where to look next

- Plugin entry: `src/index.ts`.
- LifeOps consumption: `plugins/app-lifeops/README.md`.
- Frozen contracts: `plugins/app-lifeops/docs/audit/wave1-interfaces.md`
  §5 (this plugin's contributions) and §3 (the connector / channel /
  transport contracts the plugin implements).
