/**
 * Side-effect entry point — registers the companion overlay app.
 *
 * Include this module when you want auto-registration. For explicit control,
 * import `registerCompanionApp` from the main entry:
 *   import { registerCompanionApp } from "@elizaos/plugin-companion";
 *   registerCompanionApp();
 */
import { registerCompanionApp } from "./components/companion/companion-app";

registerCompanionApp();

// In a terminal host (the Node agent, no DOM), register the companion view so it
// renders inline in the terminal. Lazy + DOM-guarded so the terminal engine
// stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view")
    .then((m) => m.registerCompanionTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}
