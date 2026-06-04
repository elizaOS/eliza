# @elizaos/plugin-background-runner

Drives core `TaskService.runDueTasks()` from OS-level wake-ups on Capacitor mobile builds, with a `setInterval` fallback for non-mobile hosts.

## Purpose / role

This plugin adds a `BgTaskSchedulerService` to an Eliza agent runtime that bridges the OS background scheduler (iOS `BGTaskScheduler` via `@capacitor/background-runner`, Android `WorkManager` via the same) to elizaOS's core task queue. On every OS wake-up the service calls `TaskService.runDueTasks()` once, then returns — no long-lived process.

It also sets `runtime.serverless = true` so core's `TaskService` defers its own timer entirely to the OS.

This plugin is **opt-in**: add it to the agent's plugin list. It registers no actions, providers, or evaluators — only the service.

## Plugin surface

**Services**
- `BgTaskSchedulerService` (`serviceType = "background_runner"`) — picks a scheduler on `start()`, sets `runtime.serverless = true`, schedules a single periodic wake (label `"eliza-tasks"`, default `15` minutes), and calls `TaskService.runDueTasks()` on each wake.

**Exported types / classes**
- `IBgTaskScheduler` — interface all scheduler implementations satisfy (`schedule`, `cancel`, `isScheduled`, `kind`).
- `CapacitorBgScheduler` — Capacitor-backed implementation (kind `"capacitor"`).
- `IntervalBgScheduler` — `setInterval` fallback (kind `"interval"`).
- `BackgroundRunnerLike`, `CapacitorEnvironment`, `resolveCapacitorEnvironment` — Capacitor environment probe.
- `BACKGROUND_RUNNER_SERVICE_TYPE` — string constant `"background_runner"`.
- `BgSchedulerKind`, `ScheduleOptions` — supporting types.

## Layout

```
src/
  index.ts                          Plugin object + re-exports
  types.ts                          IBgTaskScheduler, ScheduleOptions, BACKGROUND_RUNNER_SERVICE_TYPE
  services/
    BgTaskSchedulerService.ts       Service; picks scheduler, sets serverless, wires wake→runDueTasks
    IntervalBgScheduler.ts          setInterval fallback (non-Capacitor hosts)
  capacitor/
    bridge.ts                       Dynamic import shim; resolveCapacitorEnvironment()
    capacitor-scheduler.ts          CapacitorBgScheduler wrapping BackgroundRunner.dispatchEvent
__tests__/unit/
  bg-scheduler.test.ts              Service + scheduler unit tests
  runner-js.test.ts                 Runner-JS wire tests
INSTALL.md                          iOS/Android native setup (plist, WorkManager, runner JS, auth)
```

## Commands

```bash
bun run --cwd plugins/plugin-background-runner build         # tsc compile to dist/
bun run --cwd plugins/plugin-background-runner dev           # tsc --watch
bun run --cwd plugins/plugin-background-runner typecheck     # tsgo --noEmit
bun run --cwd plugins/plugin-background-runner test          # bun test
bun run --cwd plugins/plugin-background-runner test:unit     # bun test __tests__/unit/
bun run --cwd plugins/plugin-background-runner lint          # biome check --write --unsafe
bun run --cwd plugins/plugin-background-runner lint:check    # biome check (read-only)
bun run --cwd plugins/plugin-background-runner format        # biome format --write
bun run --cwd plugins/plugin-background-runner format:check  # biome format (read-only)
```

## Config / env vars

This plugin reads no environment variables and has no `agentConfig.pluginParameters`. All scheduling parameters are hardcoded in `BgTaskSchedulerService`:

| Constant | Value | Where |
|---|---|---|
| `RUNNER_LABEL` | `"eliza-tasks"` | Must match `capacitor.config.ts` `label` |
| `DEFAULT_INTERVAL_MINUTES` | `15` | Minimum wake interval; Android WorkManager enforces a 15-min floor anyway |

**Required peer for mobile builds:** `@capacitor/background-runner` (or the alias `@capacitor-community/background-runner`). If Capacitor native is detected but the runner package is absent the service throws rather than silently falling back to `setInterval`. See `INSTALL.md` for full iOS/Android native setup.

## How to extend

**Add a new scheduler backend** (e.g., Tauri mobile):
1. Implement `IBgTaskScheduler` from `src/types.ts` — `schedule`, `cancel`, `isScheduled`, `kind`.
2. Update `BgTaskSchedulerService.buildScheduler()` or `BgTaskSchedulerService.pickScheduler()` to detect and return the new backend.
3. Export the class from `src/index.ts`.

**Expose the service to other plugins:**
- Call `runtime.getService(BACKGROUND_RUNNER_SERVICE_TYPE)` and cast to `BgTaskSchedulerService` to call `getScheduler()` for diagnostics.

## Conventions / gotchas

- **Serverless seam.** The moment this plugin is registered, `runtime.serverless = true`. Core's `TaskService` will not run its own timer. Do not load this plugin on a server host unless you intend to disable the internal timer.
- **Mobile throw, not fallback.** On a Capacitor native platform without `@capacitor/background-runner` installed, `BgTaskSchedulerService.pickScheduler()` throws. This is intentional — silent `setInterval` on mobile produces no real background execution.
- **Wake budget.** iOS gives ~30 seconds per `BGAppRefreshTask` wake; the OS kills the process on overrun. `runDueTasks()` must complete within that window.
- **15-minute floor on Android.** WorkManager enforces a 15-minute minimum for periodic work regardless of `minimumIntervalMinutes`. Setting a smaller value in `capacitor.config.ts` will be clamped silently by Android.
- **RUNNER_LABEL must match `capacitor.config.ts`.** The label `"eliza-tasks"` is hardcoded in `BgTaskSchedulerService.ts`. Mismatching it disconnects the JS plugin from the native scheduler.
- **Runner JS is not shipped here.** The JS file the OS re-enters on wake (`runners/eliza-tasks.js`) is the host app's responsibility. See `INSTALL.md` for the expected contract (a POST to `/api/internal/wake` with the device secret).
- **Optional peers.** `@capacitor/core` and `@capacitor/background-runner` are optional peer dependencies. They are resolved at runtime via dynamic `import()` in `src/capacitor/bridge.ts` so the plugin loads without them on server/desktop hosts.
- For repo-wide rules (logger, ESM, architecture), see the root `AGENTS.md`.
