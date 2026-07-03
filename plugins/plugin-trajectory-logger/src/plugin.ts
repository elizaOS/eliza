/**
 * `@elizaos/plugin-trajectory-logger` Plugin object — the runtime contract. This
 * plugin contributes only view *declarations* (string `componentExport` /
 * `bundlePath`), no actions, providers, services, or routes. Kept free of any
 * UI imports so the agent can import it to register the plugin's views without
 * pulling the React trajectory surface into the Node process. The package
 * barrel (`index.ts`) re-exports this plus the UI for browser/view-bundle
 * consumers.
 */
import type { Plugin } from "@elizaos/core";

const trajectoryLoggerPlugin: Plugin = {
  name: "@elizaos/plugin-trajectory-logger",
  description:
    "Realtime trajectory inspector for HANDLE / PLAN / ACTION / EVALUATE phase drilldowns.",
  views: [
    // ONE declaration → GUI + XR + TUI, all drawn from the single
    // TrajectoryLoggerView spatial source. `modalities` is a plain literal here
    // (plugin.ts is not in the view bundle), so no brand-new `@elizaos/core`
    // runtime export reaches the bundle build.
    {
      id: "trajectory-logger",
      label: "Trajectory Logger",
      viewKind: "developer",
      developerOnly: true,
      description:
        "Realtime view of the agent's last and pending HANDLE / PLAN / ACTION / EVALUATE turns",
      icon: "Activity",
      path: "/trajectory-logger",
      modalities: ["gui", "xr", "tui"],
      bundlePath: "dist/views/bundle.js",
      componentExport: "TrajectoryLoggerView",
      relatedActions: ["TASKS"],
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

export { trajectoryLoggerPlugin };
export default trajectoryLoggerPlugin;
