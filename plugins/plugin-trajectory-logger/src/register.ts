/**
 * Side-effect entry — registers the Trajectory Logger overlay app.
 *
 * Load once during app startup to register the app.
 */

import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";
import { registerTrajectoryLoggerApp } from "./components/trajectory-logger-app";

registerTrajectoryLoggerApp();

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
// the render path on native. See packages/app/src/mobile-plugin-views.ts.
registerAppShellPage({
  id: "trajectory-logger",
  pluginId: "@elizaos/plugin-trajectory-logger",
  label: "Trajectory Logger",
  icon: "Activity",
  path: "/trajectory-logger",
  loader: () =>
    import("./ui.ts").then((m) => ({
      default: m.TrajectoryLoggerView,
    })),
});
