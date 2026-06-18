import { registerOperatorSurface } from "@elizaos/app-core/ui-compat";
import { ScapeOperatorSurface } from "./ScapeOperatorSurface.js";

registerOperatorSurface("@elizaos/plugin-scape", ScapeOperatorSurface);

// In a terminal host (the Node agent, no DOM), register the unified 'scape view
// so it renders inline in the terminal. Lazy + DOM-guarded so the terminal
// engine stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("../register-terminal-view.js")
    .then((m) => m.registerScapeTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}

export { ScapeOperatorSurface };
