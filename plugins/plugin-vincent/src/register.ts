// Self-register Vincent overlay app at import time.
import "./vincent-app";

// In a terminal host (the Node agent, no DOM), register the Vincent view so it
// renders inline in the terminal. Lazy + DOM-guarded so the terminal engine
// stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view")
    .then((m) => m.registerVincentTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}
