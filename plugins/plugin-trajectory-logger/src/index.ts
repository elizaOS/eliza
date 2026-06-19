import type { Plugin } from "@elizaos/core";

const trajectoryLoggerPlugin: Plugin = {
  name: "@elizaos/plugin-trajectory-logger",
  description:
    "Realtime trajectory inspector for HANDLE / PLAN / ACTION / EVALUATE phase drilldowns.",
  views: [
    {
      id: "trajectory-logger",
      label: "Trajectory Logger",
      developerOnly: true,
      description:
        "Realtime view of the agent's last and pending HANDLE / PLAN / ACTION / EVALUATE turns",
      icon: "Activity",
      path: "/trajectory-logger",
      bundlePath: "dist/views/bundle.js",
      componentExport: "TrajectoryLoggerView",
      tags: ["developer", "trajectory", "debugging"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    {
      id: "trajectory-logger",
      label: "Trajectory Logger XR",
      description:
        "Realtime view of the agent's last and pending HANDLE / PLAN / ACTION / EVALUATE turns",
      icon: "Activity",
      path: "/trajectory-logger",
      viewType: "xr",
      bundlePath: "dist/views/bundle.js",
      componentExport: "TrajectoryLoggerView",
      tags: ["developer", "trajectory", "debugging"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    {
      id: "trajectory-logger",
      label: "Trajectory Logger TUI",
      description:
        "Terminal realtime trajectory inspector for HANDLE / PLAN / ACTION / EVALUATE turns",
      icon: "Activity",
      path: "/trajectory-logger/tui",
      viewType: "tui",
      bundlePath: "dist/views/bundle.js",
      componentExport: "TrajectoryLoggerTuiView",
      capabilities: [
        {
          id: "list-trajectories",
          description: "List recent agent trajectories",
          params: {
            limit: { type: "number", description: "Maximum trajectories" },
          },
        },
        { id: "open-latest", description: "Open the latest trajectory detail" },
        {
          id: "filter-phase",
          description: "Summarize trajectories by phase",
          params: {
            phase: {
              type: "string",
              description: "Phase name such as HANDLE, PLAN, ACTION, EVALUATE",
            },
          },
        },
        { id: "refresh", description: "Refresh trajectory logger state" },
      ],
      tags: ["developer", "trajectory", "debugging", "terminal"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default trajectoryLoggerPlugin;
export type {
  TrajectoryDetail,
  TrajectoryListItem,
} from "./api-client";
export type { PhaseName, PhaseStatus, PhaseSummary } from "./phases";
export { PHASES, summarizePhases } from "./phases";
export * from "./register";
export {
  registerTrajectoryLoggerApp,
  TRAJECTORY_LOGGER_APP_NAME,
  TrajectoryLoggerView,
  trajectoryLoggerApp,
} from "./ui";
