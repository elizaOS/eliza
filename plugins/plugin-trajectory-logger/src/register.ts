/**
 * Side-effect entry — registers the Trajectory Logger terminal view (TUI) and,
 * on native, the in-process app-shell page.
 *
 * Load once during app startup.
 */

import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

// In a terminal host (the Node agent, no DOM), register the trajectory logger
// view so it renders inline in the terminal. Lazy + DOM-guarded so the terminal
// engine stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view")
    .then((m) => m.registerTrajectoryLoggerTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}

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
