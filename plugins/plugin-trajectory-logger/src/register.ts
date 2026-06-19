/**
 * Side-effect entry — registers the Trajectory Logger overlay app.
 *
 * Load once during app startup to register the app.
 */

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
