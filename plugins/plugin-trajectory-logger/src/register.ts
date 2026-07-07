/**
 * Side-effect entry — registers, on native, the Trajectory Logger in-process
 * app-shell page.
 *
 * Load once during app startup.
 */

import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

// iOS/Android disable DynamicViewLoader, so register this view's already-bundled
// component as an in-process app-shell page. Web/desktop dedupe it against the
// agent-served bundle entry (network wins -> DynamicViewLoader), so it only adds
// the render path on native.
registerAppShellPage({
  id: "trajectory-logger",
  pluginId: "@elizaos/plugin-trajectory-logger",
  label: "Trajectory Logger",
  viewKind: "developer",
  developerOnly: true,
  icon: "Activity",
  path: "/trajectory-logger",
  loader: () =>
    import("./ui.ts").then((m) => ({
      default: m.TrajectoryLoggerView,
    })),
});
