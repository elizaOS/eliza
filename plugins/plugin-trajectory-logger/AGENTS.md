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
  usePollingTrajectories.test.tsx  Tests for the polling hook
  api-client.contract.test.ts      Contract tests for the API client
  ui.ts                            Re-exports TrajectoryLoggerView,
                                   registerTrajectoryLoggerApp, trajectoryLoggerApp
  register.ts                      Side-effect entry; calls registerTrajectoryLoggerApp()
                                   once on import
  register-terminal-view.tsx       Registers the trajectory logger view with the
                                   @elizaos/tui terminal registry for viewType:"tui"
  components/
    TrajectoryLoggerView.tsx       Root view component + TUI view (TrajectoryLoggerTuiView)
                                   + per-slot PhaseStrip
    TrajectoryLoggerView.interact.ts  interact() capability handler (split out from
                                   TrajectoryLoggerView.tsx to keep it Fast-Refresh-compatible)
    TrajectoryLoggerSpatialView.tsx   Spatial/XR view component; renders in
                                   <SpatialSurface> for GUI and XR contexts
    trajectory-logger-view-bundle.ts  Vite view-bundle entry; re-exports
                                   TrajectoryLoggerView, TrajectoryLoggerTuiView,
                                   and interact for dist/views/bundle.js
    PhaseChip.tsx                  Clickable phase tab chip with status dot
    PhaseDrilldown.tsx             Phase detail body (HANDLE/PLAN/ACTION/EVALUATE)
    trajectory-logger-app.ts      OverlayApp definition + registerTrajectoryLoggerApp()
    trajectory-logger-app.test.ts Tests for the overlay app registration
    PhaseDrilldown.render.test.tsx Render tests for PhaseDrilldown
    TrajectoryLoggerSpatialView.test.tsx  Tests for the spatial view
    TrajectoryLoggerTuiView.render.test.tsx  Render tests for the TUI view
    TrajectoryLoggerView.interact.test.ts    Tests for the interact handler
    TrajectoryLoggerView.render.test.tsx     Render tests for the main view
    TrajectoryLoggerView.visual-copy.test.ts Visual-copy regression tests
test/
  phases.test.ts                   Unit tests for summarizePhases / extractShouldRespondDecision
  realtime.test.ts                 Polling / realtime integration tests
```

## Commands

All scripts require a built `dist/` first (via `bun run build`).

```bash
bun run --cwd plugins/plugin-trajectory-logger typecheck   # tsgo --noEmit
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
5. Register a new capability in the TUI view array in `src/index.ts` and handle it in `interact()` in `src/components/TrajectoryLoggerView.interact.ts`.

**Add a new API client method:**

Add a typed `fetch` wrapper to `src/api-client.ts` following the `readJson<T>` pattern. Export it from `src/index.ts` if it should be consumable by other packages.

## Conventions / gotchas

- **Two build steps:** `build:js` (tsup — ESM plugin entry) and `build:views` (Vite — standalone view bundle at `dist/views/bundle.js`). Both must run; the plugin runtime imports the Vite bundle by `bundlePath`, not the tsup output.
- **No SSR in views.** `TrajectoryLoggerView` is loaded by the overlay system in a browser context only; do not rely on Node APIs inside components.
- **API server dependency.** All data comes from `/api/trajectories*`. The plugin does not write trajectory data — that is `@elizaos/plugin-training`'s responsibility.
- **Polling interval is 700 ms** (`POLL_MS` in `usePollingTrajectories.ts`). The hook uses `AbortController` to cancel in-flight requests on unmount; do not add `setInterval`-based polling alongside it.
- **`register.ts` is a side-effect import.** Importing it calls `registerTrajectoryLoggerApp()` immediately. Guard with the `registered` flag in `trajectory-logger-app.ts` to prevent double registration.
- **View bundle entry.** `vite.config.views.ts` points to `src/components/trajectory-logger-view-bundle.ts` (not `TrajectoryLoggerView.tsx` directly) and re-exports `TrajectoryLoggerView`, `TrajectoryLoggerTuiView`, and `interact` as named exports. If entry or export names change, update both the vite config and the `views` array in `src/index.ts`.
- **interact() is split out.** The TUI capability handler lives in `src/components/TrajectoryLoggerView.interact.ts`, not in `TrajectoryLoggerView.tsx`, so that the component file stays Fast-Refresh-compatible.
- **Phase classification heuristic.** `phaseOf()` in `phases.ts` classifies LLM calls by matching `stepType` or `purpose` against hard-coded sets. Calls that match none are silently omitted from all phases (they will not appear in any drilldown).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
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

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — eval / trajectory harness:**
- A live-model scenario run producing the JSON report + run viewer + native jsonl, with the trajectory **opened and reviewed**.
- The harness's own e2e tests against a real `AgentRuntime` — not a mocked runtime; assert **outcomes**, not routing (see #9970).
- Determinism/seed handling and the failure/partial-run reporting paths.
- The shape of the corpus/records emitted, inspected by hand.
<!-- END: evidence-and-e2e-mandate -->
