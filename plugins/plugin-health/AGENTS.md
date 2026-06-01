# @elizaos/plugin-health

Health, sleep, circadian-regularity, and screen-time domain plugin for elizaOS.

## Purpose / role

Provides the health and sleep domain layer for Eliza agents — connector registrations (Apple Health, Google Fit, Strava, Fitbit, Withings, Oura), sleep/circadian/regularity inference engines, screen-time type contracts, wake/bedtime anchor contributions, `ActivitySignalBus` family declarations, and default scheduled-task packs (bedtime, wake-up, sleep-recap). Loaded as `healthPlugin` (package `@elizaos/plugin-health`). Opt-in; consumed by plugins such as `@elizaos/plugin-lifeops`. All registry contributions are soft-dependency: if `connectorRegistry`, `anchorRegistry`, `busFamilyRegistry`, or `defaultPackRegistry` are absent on the runtime, the plugin logs a one-line skip and continues without error.

## Plugin surface

The plugin object (`healthPlugin`) registers no actions, providers, or evaluators. Its `init` function calls four registration helpers:

| Registration call | What it contributes |
|---|---|
| `registerHealthConnectors(runtime)` | 6 `ConnectorContribution`s: `apple_health`, `google_fit`, `strava`, `fitbit`, `withings`, `oura` |
| `registerHealthAnchors(runtime)` | 4 `AnchorContribution`s: `wake.observed`, `wake.confirmed`, `bedtime.target`, `nap.start` |
| `registerHealthBusFamilies(runtime)` | 8 `BusFamilyContribution`s: `health.sleep.detected`, `health.sleep.ended`, `health.wake.observed`, `health.wake.confirmed`, `health.nap.detected`, `health.bedtime.imminent`, `health.regularity.changed`, `health.workout.completed` |
| `registerHealthDefaultPacks(runtime)` | 3 `DefaultPack`s: `bedtime`, `wake-up`, `sleep-recap` |

`init` also calls `registerCircadianInsightContract(runtime, createDefaultCircadianInsightContract())` to attach the `CircadianInsightContract` seam on the runtime symbol `Symbol.for("@elizaos/plugin-health:circadian-insight-contract")`.

### Key exported constants

- `HEALTH_CONNECTOR_KINDS` — tuple of the 6 connector kind strings.
- `HEALTH_ANCHORS` — tuple of the 4 anchor key strings.
- `HEALTH_BUS_FAMILIES` — tuple of the 8 bus family strings.
- `HEALTH_DEFAULT_PACKS` — array of the 3 `DefaultPack` objects.
- `HEALTH_PLUGIN_NAME` — `"plugin-health"`.

### Key exported functions / contracts

- `getCircadianInsightContract(runtime)` — resolves the registered `CircadianInsightContract` from the runtime; returns `null` if not registered.
- `registerCircadianInsightContract(runtime, contract)` — attaches an implementation.
- `createDefaultCircadianInsightContract()` — factory for the built-in implementation.
- `getHealthProviderSpec(kind)` / `setHealthProviderSpec(kind, spec)` — read/write the per-provider OAuth + API-base-URL registry.

## Layout

```
src/
  index.ts                      Plugin entry; exports healthPlugin + all public surfaces
  actions/
    index.ts                    No actions at Wave-1 (deferred to Wave-2); exports HEALTH_ACTIONS_DEFERRED_TO_WAVE_2
  anchors/
    index.ts                    Re-exports HEALTH_ANCHORS + registerHealthAnchors from connectors/
  connectors/
    index.ts                    registerHealthConnectors / registerHealthAnchors / registerHealthBusFamilies;
                                  HEALTH_CONNECTOR_KINDS, HEALTH_ANCHORS, HEALTH_BUS_FAMILIES constants
    contract-stubs.ts           Local structural types for ConnectorRegistry, AnchorRegistry, BusFamilyRegistry,
                                  ConnectorContribution, etc. (until W1-F registry interfaces are published)
  contracts/
    health.ts                   Re-exports all LifeOps health/sleep/screen-time types from lifeops.js;
                                  also exports LIFEOPS_* runtime constants
    circadian.ts                CircadianInsightContract interface, SleepWindow, SchedulingWindow;
                                  registerCircadianInsightContract / getCircadianInsightContract
    circadian-default.ts        createDefaultCircadianInsightContract() — built-in implementation
    lifeops.ts                  LifeOps connector-degradation re-exports + LIFEOPS_TIME_WINDOW_NAMES,
                                  LIFEOPS_DEFINITION_KINDS, and related types
    lifeops-connector-degradation.ts  LIFEOPS_CONNECTOR_DEGRADATION_AXES tuple +
                                  LifeOpsConnectorDegradation / LifeOpsConnectorDegradationAxis types
    permissions.ts              SystemPermissionId / PermissionStatus types (shared system permission contracts)
  default-packs/
    index.ts                    registerHealthDefaultPacks; HEALTH_DEFAULT_PACKS; exports bedtime/wake-up/sleep-recap packs
    bedtime.ts                  bedtimeDefaultPack definition
    wake-up.ts                  wakeUpDefaultPack definition
    sleep-recap.ts              sleepRecapDefaultPack definition
    contract-stubs.ts           DefaultPack / DefaultPackRegistry structural types
  health-bridge/
    index.ts                    Barrel: re-exports all health-bridge modules
    health-bridge.ts            detectHealthBackend — HealthKit (darwin) or Google Fit REST fallback
    health-connectors.ts        OAuth-bridged readers for Strava, Fitbit, Withings, Oura
    health-oauth.ts             Per-provider OAuth dance and pending-session state
    health-provider-registry.ts HealthProviderSpec registry; getHealthProviderSpec / setHealthProviderSpec
    health-records.ts           createLifeOpsHealth* record factories
    service-normalize-health.ts normaliseHealthSignal — normalises inbound health-signal payloads
  screen-time/
    index.ts                    Type-only exports: LifeOpsScreenTimePerAppUsage, LifeOpsScreenTimeSummaryPayload
  sleep/
    index.ts                    Barrel: all sleep/circadian domain helpers
    awake-probability.ts        computeAwakeProbability — logistic awake-probability model
    circadian-rules.ts          Circadian state transitions; WAKE_CONFIRM_WINDOW_MS hysteresis
    sleep-cycle.ts              SleepCycle model; resolveCurrentSleepCycle
    sleep-cycle-dispatch.ts     Sleep-cycle event dispatch helpers
    sleep-episode-store.ts      SleepEpisodeRepository helpers; pure domain, no SQL coupling
    sleep-episode-types.ts      SleepEpisodeRepository interface; LifeOpsHealthSleepEpisode derivatives
    sleep-recap.ts              buildSleepRecapPayload
    sleep-regularity.ts         computeSleepRegularity — regularity scoring
    sleep-wake-events.ts        Sleep/wake event detection helpers
    source-reliability.ts       resolveActivitySignalReliability — per-source confidence weights
  util/
    index.ts                    Barrel: re-exports time.ts + time-util.ts
    time.ts                     getZonedDateParts — IANA timezone date arithmetic
    time-util.ts                parseIsoMs and other time helpers
    normalize.ts                normalisation helpers
    token-encryption.ts         Token encryption/decryption helpers (connector credential store)
```

## Commands

```bash
bun run --cwd plugins/plugin-health test          # vitest run
bun run --cwd plugins/plugin-health build         # build:js (tsup) + build:types (tsc)
bun run --cwd plugins/plugin-health build:js      # tsup only
bun run --cwd plugins/plugin-health build:types   # tsc --noCheck
bun run --cwd plugins/plugin-health clean         # rm -rf dist
bun run --cwd plugins/plugin-health lint          # biome check --write --unsafe
bun run --cwd plugins/plugin-health lint:check    # biome check (read-only)
```

## Config / env vars

This plugin reads no env vars directly. Connector OAuth credentials (client IDs, secrets, tokens) are stored in the runtime credential store managed by `health-oauth.ts`. They are not env-var-gated; the connector contribution's `start()` call provisions credentials through the runtime OAuth flow.

## How to extend

### Add a new connector kind

1. Add the kind string to `HEALTH_CONNECTOR_KINDS` in `src/connectors/index.ts`.
2. Add entries to `HEALTH_CONNECTOR_CAPABILITIES` and `CONNECTOR_LABELS` in the same file.
3. Add a `HealthProviderSpec` entry via `setHealthProviderSpec(kind, spec)` in `src/health-bridge/health-provider-registry.ts` (or call it at runtime boot).
4. Wire the OAuth reader in `src/health-bridge/health-connectors.ts`.
5. Export from `src/health-bridge/index.ts` if new public helpers are added.

### Add an action

Wave-1 note: actions are deferred to Wave-2 (`HEALTH_ACTIONS_DEFERRED_TO_WAVE_2`). When the time comes, create `src/actions/<name>.ts`, export from `src/actions/index.ts`, and add to the `actions` array in `healthPlugin` in `src/index.ts`. Actions that require `LifeOpsService` cannot live here without the W2-A decoupling; keep those in `plugin-lifeops` until then.

### Add a default pack

Create `src/default-packs/<name>.ts` implementing `DefaultPack`, add it to `HEALTH_DEFAULT_PACKS` in `src/default-packs/index.ts`, and export it.

## Conventions / gotchas

- **Wave-1 soft-dependency posture.** All four `register*` calls in `init` check for the registry on the runtime and log a single skip line if absent — never throw. Callers do not need to guard.
- **No actions at Wave-1.** The `actions: []` in `healthPlugin` is intentional; `plugin-lifeops` continues to host the health actions until Wave-2 decouples `LifeOpsService`.
- **No `app-lifeops` build-time dep.** `src/util/time.ts` and `src/util/time-util.ts` are local copies of same-named helpers to avoid a circular dependency. Do not replace them with imports from `app-lifeops`.
- **CircadianInsightContract is the canonical seam.** Any code that needs circadian state or scheduling-window inference resolves it via `getCircadianInsightContract(runtime)` — never deep-imports `src/sleep/*` from outside the plugin.
- **screen-time aggregation lives upstream.** `src/screen-time/index.ts` exports only types. The actual aggregator lives in `plugin-lifeops` pending Wave-2 (W2-D) signal-bus decoupling.
- **Token encryption.** `src/util/token-encryption.ts` encrypts OAuth tokens at rest using a per-runtime key; do not store raw tokens elsewhere.
- See root `AGENTS.md` for global architecture rules, logger conventions, and ESM/naming requirements.
