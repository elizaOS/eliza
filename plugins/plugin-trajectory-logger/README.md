# @elizaos/plugin-trajectory-logger

A developer plugin for elizaOS that provides a realtime trajectory inspector, showing the agent's active and last-completed turns broken down by phase: **HANDLE → PLAN → ACTION → EVALUATE**.

## What it does

When installed, the plugin adds an overlay view to the elizaOS UI. The view polls the trajectory API every 700 ms and displays two side-by-side strips:

- **Current turn** — the in-flight trajectory, with the active phase pulsing.
- **Last turn** — the most recently completed trajectory.

Clicking any phase chip expands a drilldown showing LLM calls, provider accesses, tool events, or evaluator results depending on the phase.

A **TUI variant** is also registered for terminal environments, supporting the `list-trajectories`, `open-latest`, `filter-phase`, and `refresh` capabilities.

## Phases

| Phase | What it covers |
|---|---|
| HANDLE | `should_respond` and `compose_state` LLM calls; provider context accesses |
| PLAN | Reasoning, response, and action LLM calls |
| ACTION | Tool/action execution events (call, result, error, duration) |
| EVALUATE | Evaluator LLM calls and evaluation events with decisions |

## Requirements

- **`@elizaos/plugin-training`** must be loaded alongside this plugin. It serves the `/api/trajectories` and `/api/trajectories/:id` routes that this inspector reads from. Without it, the view shows a fetch error.

## Installation

Add the plugin to your agent character file:

```json
{
  "plugins": ["@elizaos/plugin-trajectory-logger"]
}
```

Or register it programmatically:

```ts
import trajectoryLoggerPlugin from "@elizaos/plugin-trajectory-logger";

const agent = new AgentRuntime({
  plugins: [trajectoryLoggerPlugin],
  // ...
});
```

## Configuration

No environment variables or settings are required. The plugin reads data from the running elizaOS API server.

## Exported API

The package entry (`@elizaos/plugin-trajectory-logger`) re-exports, in addition to the default plugin:

- `summarizePhases(detail, options)` — maps a `TrajectoryDetail` into `PhaseSummary[]` with status and summary text per phase.
- `PHASES` — readonly array `["HANDLE", "PLAN", "ACTION", "EVALUATE"]` (typed `readonly PhaseName[]`).
- `TrajectoryLoggerView` — the React overlay component.
- `registerTrajectoryLoggerApp()` — registers the overlay app in the `@elizaos/ui` overlay registry (called automatically on plugin load via `register.ts`).
- `trajectoryLoggerApp` / `TRAJECTORY_LOGGER_APP_NAME` — the `OverlayApp` definition and its name.
- Types: `TrajectoryDetail`, `TrajectoryListItem`, `PhaseName`, `PhaseStatus`, `PhaseSummary`.

The typed fetch helpers (`fetchTrajectoryList`, `fetchTrajectoryDetail`, `purgeTrajectory`, `fetchTrajectoryExport`) live in `src/api-client.ts` and are reachable via the `@elizaos/plugin-trajectory-logger/api-client` subpath, not the main entry. `fetchTrajectoryExport` returns the `/export` archive as a `Blob`.

## Privacy

Trajectory logging is controlled by the elizaOS runtime (see `ELIZA_DISABLE_TRAJECTORY_LOGGING=1` to disable). This plugin only reads and displays existing trajectory data — it does not write or enable logging on its own.
