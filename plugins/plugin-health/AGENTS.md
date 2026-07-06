# @elizaos/plugin-health

Health, sleep, circadian-regularity, and screen-time domain plugin for elizaOS.

## Purpose / role

Provides the health and sleep domain layer for Eliza agents — connector registrations (Apple Health, Google Fit, Strava, Fitbit, Withings, Oura), sleep/circadian/regularity inference engines, screen-time type contracts, wake/bedtime anchor contributions, `ActivitySignalBus` family declarations, and default scheduled-task packs (bedtime, wake-up, sleep-recap). Loaded as `healthPlugin` (package `@elizaos/plugin-health`). Opt-in; consumed by plugins such as `@elizaos/plugin-personal-assistant`. All registry contributions are soft-dependency: if `connectorRegistry`, `anchorRegistry`, `busFamilyRegistry`, or `defaultPackRegistry` are absent on the runtime, the plugin logs a one-line skip and continues without error.

## Plugin surface

The plugin object (`healthPlugin`) registers no runtime actions, providers, or evaluators directly. Health owns the reusable action/provider/route/service surfaces (`createOwnerHealthAction`, `createOwnerScreenTimeAction`, `createHealthActionRunner`, `createScreenTimeActionRunner`, `createHealthProvider`, `createHealthSleepRouteHandler`, `createHealthSleepServiceMethods`) so host plugins inject access checks, route context, and storage/service adapters instead of duplicating health metadata. Its `init` function calls four registration helpers:

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
- `getHealthProviderSpec(provider)` / `setHealthProviderSpec(spec)` — read/register a `HealthProviderSpec` in the per-provider OAuth registry (the spec carries its own `provider` key).

## Layout

```
src/
  index.ts                      Plugin entry; exports healthPlugin + all public surfaces
  actions/
    index.ts                    Health/screen-time action factories and runner adapters for host plugins
    health.ts                   Health action implementation
    owner-health.ts             Owner health action factory
    owner-screentime.ts         Owner screen-time action factory
    screen-time.ts              Screen-time action implementation
  anchors/
    index.ts                    Re-exports HEALTH_ANCHORS + registerHealthAnchors from connectors/
  components/
    health/
      HealthView.tsx            React UI component for health data display
      health-view-bundle.ts     Bundle entry for the health view
  connectors/
    index.ts                    registerHealthConnectors / registerHealthAnchors / registerHealthBusFamilies;
                                  HEALTH_CONNECTOR_KINDS, HEALTH_ANCHORS, HEALTH_BUS_FAMILIES constants
    contract-types.ts           Local structural types for ConnectorRegistry, AnchorRegistry, BusFamilyRegistry,
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
    contract-types.ts           DefaultPack / DefaultPackRegistry structural types
  health-bridge/
    index.ts                    Barrel: re-exports all health-bridge modules
    health-bridge.ts            detectHealthBackend — HealthKit (darwin) or Google Fit REST fallback
    health-connectors.ts        OAuth-bridged readers for Strava, Fitbit, Withings, Oura
    health-oauth.ts             Per-provider OAuth dance and pending-session state
    health-provider-registry.ts HealthProviderSpec registry; getHealthProviderSpec / setHealthProviderSpec
    health-records.ts           createLifeOpsHealth* record factories
    service-normalize-health.ts normalizeHealthSignal — normalizes inbound health-signal payloads
  providers/
    index.ts                    Barrel: health provider exports
    health.ts                   createHealthProvider factory
  routes/
    index.ts                    Re-exports health-owned route factories
    sleep.ts                    createHealthSleepRouteHandler for sleep history / regularity / baseline
  screen-time/
    index.ts                    Screen-time exports and LifeOpsScreenTimeSummaryPayload contract
    builders.ts                 Pure summary / breakdown / metrics / visible-bucket builders
    mobile-signal-setup.ts      Mobile signal setup helpers
    mobile-signals.ts           Android Usage Stats / iOS Screen Time signal parsing and data-source status helpers
    ranges.ts                   Screen-time range labels / current+prior windows / history day enumeration
    social-taxonomy.ts          Screen-time target classification by category / device / service / browser
    system-inactivity-apps.ts   OS lock / screen-saver app classification for screen-time filtering
  sleep/
    index.ts                    Barrel: all sleep/circadian domain helpers
    awake-probability.ts        computeAwakeProbability — logistic awake-probability model
    circadian-rules.ts          Circadian state transitions; WAKE_CONFIRM_WINDOW_MS hysteresis
    sleep-cycle.ts              resolveLifeOpsSleepCycle; classifyLifeOpsSleepCycleType; resolveLifeOpsDayBoundary
    sleep-cycle-dispatch.ts     Sleep-cycle event dispatch helpers
    sleep-episode-store.ts      SleepEpisodeRepository helpers; pure domain, no SQL coupling
    sleep-episode-types.ts      SleepEpisodeRepository interface; LifeOpsHealthSleepEpisode derivatives
    sleep-recap.ts              SleepRecap interface (recap payload shape)
    sleep-regularity.ts         computeSleepRegularity — regularity scoring
    sleep-service.ts            createHealthSleepServiceMethods for history / regularity / baseline DTOs
    sleep-wake-events.ts        Sleep/wake event detection helpers
    source-reliability.ts       resolveActivitySignalReliability — per-source confidence weights
  ui/
    index.ts                    Barrel: UI assistant command exports
    assistant-commands.ts       UI assistant command helpers
  util/
    index.ts                    Barrel: re-exports time.ts + time-util.ts
    time.ts                     getZonedDateParts — IANA timezone date arithmetic
    time-util.ts                parseIsoMs and other time helpers
    normalize.ts                normalisation helpers
    token-encryption.ts         Token encryption/decryption helpers (connector credential store)
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-health clean           # remove build output
bun run --cwd plugins/plugin-health build           # build package artifacts
bun run --cwd plugins/plugin-health build:js        # js build lane
bun run --cwd plugins/plugin-health build:views     # views build lane
bun run --cwd plugins/plugin-health build:types     # types build lane
bun run --cwd plugins/plugin-health typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-health lint            # mutating Biome check
bun run --cwd plugins/plugin-health lint:check      # read-only Biome check
bun run --cwd plugins/plugin-health format          # write formatting
bun run --cwd plugins/plugin-health format:check    # read-only formatting check
bun run --cwd plugins/plugin-health test            # run package tests
bun run --cwd plugins/plugin-health test:scenarios  # scenarios test lane
```

## Config / env vars

| Env var | Read in | Purpose |
|---|---|---|
| `ELIZA_TOKEN_ENCRYPTION_KEY` | `util/token-encryption.ts` | AES-256-GCM key for OAuth tokens at rest; falls back to a lazily-created `<credentialsDir>/.encryption-key` file (mode 0600) when unset. |
| `ELIZA_<PREFIX>_CLIENT_ID` / `ELIZA_<PREFIX>_CLIENT_SECRET` / `ELIZA_<PREFIX>_PUBLIC_BASE_URL` | `health-bridge/health-oauth.ts` | Per-provider OAuth config. `<PREFIX>` is the provider `envPrefix`: `STRAVA`, `FITBIT`, `WITHINGS`, `OURA`. |
| `ELIZA_HEALTHKIT_CLI_PATH` | `health-bridge/health-bridge.ts` | Path to the HealthKit native CLI helper (darwin). |
| `ELIZA_GOOGLE_FIT_ACCESS_TOKEN` | `health-bridge/health-bridge.ts` | Access token for the Google Fit REST fallback. |
| `ELIZA_TEST_HEALTH_BACKEND` | `health-bridge/health-bridge.ts` | Force a specific backend (test override). |
| `ELIZA_MOCK_GOOGLE_BASE` | `health-bridge/health-bridge.ts` | Loopback-only mock API base for Google Fit tests. |
| `ELIZA_MOCK_HEALTH_BASE` / `ELIZA_MOCK_<PROVIDER>_BASE` | `health-bridge/health-connectors.ts` | Loopback-only mock API bases for tests (`<PROVIDER>` upper-cased); `ELIZA_MOCK_HEALTH_BASE` is the fallback when no provider-specific override is set. |

The OAuth-dir root is resolved via `resolveOAuthDir` from `@elizaos/core`, so its own env knobs are owned upstream, not here.

## How to extend

### Add a new connector kind

1. Add the kind string to `HEALTH_CONNECTOR_KINDS` in `src/connectors/index.ts`.
2. Add entries to `HEALTH_CONNECTOR_CAPABILITIES` and `CONNECTOR_LABELS` in the same file.
3. Add a `HealthProviderSpec` entry via `setHealthProviderSpec(spec)` (the spec carries its own `provider` and `envPrefix`) in `src/health-bridge/health-provider-registry.ts` (or call it at runtime boot).
4. Wire the OAuth reader in `src/health-bridge/health-connectors.ts`.
5. Export from `src/health-bridge/index.ts` if new public helpers are added.

### Add an action surface

Action metadata and parameter ownership belongs here. If the action still needs LifeOps persistence or owner access checks, expose a factory/runner pair that accepts host adapters instead of importing `@elizaos/plugin-personal-assistant`. Only add an action directly to `healthPlugin.actions` when it no longer depends on LifeOps storage or routing.

### Add a default pack

Create `src/default-packs/<name>.ts` implementing `DefaultPack`, add it to `HEALTH_DEFAULT_PACKS` in `src/default-packs/index.ts`, and export it.

## Conventions / gotchas

- **Wave-1 soft-dependency posture.** All four `register*` calls in `init` check for the registry on the runtime and log a single skip line if absent — never throw. Callers do not need to guard.
- **Action registration vs action ownership.** The `actions: []` in `healthPlugin` is still intentional for runtime registration, but action metadata and planning surfaces live here. `@elizaos/plugin-personal-assistant` may register host-adapted health actions only by calling plugin-health factories.
- **No `app-lifeops` build-time dep.** `src/util/time.ts` and `src/util/time-util.ts` are local copies of same-named helpers to avoid a circular dependency. Do not replace them with imports from `app-lifeops`.
- **CircadianInsightContract is the canonical seam.** Any code that needs circadian state or scheduling-window inference resolves it via `getCircadianInsightContract(runtime)` — never deep-imports `src/sleep/*` from outside the plugin.
- **screen-time aggregation ownership.** `src/screen-time/` owns taxonomy/classification, range/window helpers, mobile signal parsing/status helpers, pure summary/breakdown/metrics builders, system-inactivity filtering, and shared payload contracts. The repository-backed aggregator lives in `@elizaos/plugin-personal-assistant` while signal-bus ownership remains split across the two plugins.
- **Token encryption.** `src/util/token-encryption.ts` encrypts OAuth tokens at rest using a per-runtime key; do not store raw tokens elsewhere.
- See root `AGENTS.md` for global architecture rules, logger conventions, and ESM/naming requirements.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — agent behavior / app plugin:**
- A **live-LLM** scenario trajectory showing the behavior end to end and asserting the **outcome**, not just that routing/an action was selected (see #9970).
- The artifacts the behavior creates — memories, knowledge, scheduled-task rows, relationships, documents, outputs — inspected after the run.
- Backend `[ClassName]` logs of the action/service/runner firing, plus error/edge/permission paths.
- The empty-state and adversarial-input behavior, not just one happy scenario.
<!-- END: evidence-and-e2e-mandate -->
