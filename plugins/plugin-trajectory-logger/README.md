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

The package also exports utilities useful for building custom trajectory views:

- `summarizePhases(detail, options)` — maps a `TrajectoryDetail` into `PhaseSummary[]` with status and summary text per phase.
- `extractShouldRespondDecision(call)` — parses a `should_respond` LLM call response into a `{ decision, reasoning }` object.
- `PHASES` — readonly tuple `["HANDLE", "PLAN", "ACTION", "EVALUATE"]`.
- `fetchTrajectoryList(options)` — typed fetch for `GET /api/trajectories`.
- `fetchTrajectoryDetail(id, options)` — typed fetch for `GET /api/trajectories/:id`.
- `purgeTrajectory(id)` — `DELETE /api/trajectories/:id`.
- `fetchTrajectoryExport(id)` — downloads a signed zip of a trajectory.
- `registerTrajectoryLoggerApp()` — registers the overlay app in the elizaOS UI registry (called automatically on plugin load).

## Privacy

Trajectory logging is controlled by the elizaOS runtime (see `ELIZA_DISABLE_TRAJECTORY_LOGGING=1` to disable). This plugin only reads and displays existing trajectory data — it does not write or enable logging on its own.
