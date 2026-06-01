# @elizaos/plugin-trajectory-logger

Realtime trajectory inspector that surfaces an Eliza agent's last completed and in-flight turns with per-phase drilldowns.

## Purpose / role

Adds a developer-facing overlay UI to elizaOS that renders the agent's active and most-recently-completed trajectory side-by-side, broken into HANDLE / PLAN / ACTION / EVALUATE phases. Loaded as an optional plugin; add it to the `plugins` array in your agent character file. No actions, providers, services, or evaluators are registered — this plugin contributes only `views` to the elizaOS plugin surface.

Data is read from `GET /api/trajectories` and `GET /api/trajectories/:id`, which are served by `@elizaos/plugin-training`.

## Plugin surface

**Views registered** (all share `id: "trajectory-logger"`):

| View | viewType | componentExport | bundlePath |
|---|---|---|---|
| Trajectory Logger | (default web) | `TrajectoryLoggerView` | `dist/views/bundle.js` |
| Trajectory Logger XR | `xr` | `TrajectoryLoggerView` | `dist/views/bundle.js` |
| Trajectory Logger TUI | `tui` | `TrajectoryLoggerTuiView` | `dist/views/bundle.js` |

**TUI capabilities**: `list-trajectories`, `open-latest`, `filter-phase`, `refresh`.

No actions, providers, services, evaluators, routes, or events are registered.

## Layout

```
src/
  index.ts                         Plugin object + re-exports
  api-client.ts                    Typed fetch wrappers: fetchTrajectoryList,
                                   fetchTrajectoryDetail, purgeTrajectory,
                                   fetchTrajectoryExport; wire types for
                                   /api/trajectories responses
  phases.ts                        Phase classification logic: PHASES constant,
                                   summarizePhases(), extractShouldRespondDecision();
                                   maps LLM call stepType/purpose → PhaseName
  usePollingTrajectories.ts        React hook; polls at 700 ms, returns active +
                                   last trajectory detail
  ui.ts                            Re-exports TrajectoryLoggerView,
                                   registerTrajectoryLoggerApp, trajectoryLoggerApp
  register.ts                      Side-effect entry; calls registerTrajectoryLoggerApp()
                                   once on import
  components/
    TrajectoryLoggerView.tsx       Root view + TUI view + per-slot PhaseStrip
    PhaseChip.tsx                  Clickable phase tab chip with status dot
    PhaseDrilldown.tsx             Phase detail body (HANDLE/PLAN/ACTION/EVALUATE)
    trajectory-logger-app.ts      OverlayApp definition + registerTrajectoryLoggerApp()
test/
  phases.test.ts                   Unit tests for summarizePhases / extractShouldRespondDecision
  realtime.test.ts                 Polling / realtime integration tests
```

## Commands

All scripts require a built `dist/` first (via `bun run build`).

```bash
bun run --cwd plugins/plugin-trajectory-logger typecheck   # tsc --noEmit
bun run --cwd plugins/plugin-trajectory-logger lint        # biome check src
bun run --cwd plugins/plugin-trajectory-logger test        # vitest run
bun run --cwd plugins/plugin-trajectory-logger build       # build:js + build:views + build:types
bun run --cwd plugins/plugin-trajectory-logger clean       # rm -rf dist
```

## Config / env vars

None. This plugin reads no env vars and requires no configuration. The only external dependency is the `/api/trajectories` route provided by `@elizaos/plugin-training`; if that plugin is absent the views display a fetch error.

## How to extend

**Add a new phase drilldown body:**

1. Add the phase name to `PhaseName` in `src/phases.ts` and append it to the `PHASES` array.
2. Add classification logic in `phaseOf()` (add step types to the relevant `Set`).
3. Add a `summarize<Phase>` function and wire it into `summarizePhases()`.
4. Add a case to the `switch` in `PhaseDrilldown.tsx` returning a new body component.
5. Register a new capability in the TUI view array in `src/index.ts` and handle it in `interact()` in `TrajectoryLoggerView.tsx`.

**Add a new API client method:**

Add a typed `fetch` wrapper to `src/api-client.ts` following the `readJson<T>` pattern. Export it from `src/index.ts` if it should be consumable by other packages.

## Conventions / gotchas

- **Two build steps:** `build:js` (tsup — ESM plugin entry) and `build:views` (Vite — standalone view bundle at `dist/views/bundle.js`). Both must run; the plugin runtime imports the Vite bundle by `bundlePath`, not the tsup output.
- **No SSR in views.** `TrajectoryLoggerView` is loaded by the overlay system in a browser context only; do not rely on Node APIs inside components.
- **API server dependency.** All data comes from `/api/trajectories*`. The plugin does not write trajectory data — that is `@elizaos/plugin-training`'s responsibility.
- **Polling interval is 700 ms** (`POLL_MS` in `usePollingTrajectories.ts`). The hook uses `AbortController` to cancel in-flight requests on unmount; do not add `setInterval`-based polling alongside it.
- **`register.ts` is a side-effect import.** Importing it calls `registerTrajectoryLoggerApp()` immediately. Guard with the `registered` flag in `trajectory-logger-app.ts` to prevent double registration.
- **View bundle entry.** `vite.config.views.ts` points to `src/components/TrajectoryLoggerView.tsx` and exports `TrajectoryLoggerView` as the component name. If the entry or export name changes, update both the vite config and the `views` array in `src/index.ts`.
- **Phase classification heuristic.** `phaseOf()` in `phases.ts` classifies LLM calls by matching `stepType` or `purpose` against hard-coded sets. Calls that match none are silently omitted from all phases (they will not appear in any drilldown).
