import {
  registerDetailExtension,
  registerOperatorSurface,
} from "@elizaos/app-core/ui-compat";
import { DefenseAgentsDetailExtension } from "./DefenseAgentsDetailExtension.js";
import { DefenseAgentsOperatorSurface } from "./DefenseAgentsOperatorSurface.js";

registerOperatorSurface(
  "@elizaos/plugin-defense-of-the-agents",
  DefenseAgentsOperatorSurface,
);
registerDetailExtension("defense-agent-control", DefenseAgentsDetailExtension);

// In a terminal host (the Node agent, no DOM), register the unified spatial view
// so the plugin's `viewType: "tui"` declaration renders inline in the terminal.
// Lazy + DOM-guarded so the terminal engine stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("../register-terminal-view.js")
    .then((m) => m.registerDefenseTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}

export { DefenseAgentsDetailExtension, DefenseAgentsOperatorSurface };
