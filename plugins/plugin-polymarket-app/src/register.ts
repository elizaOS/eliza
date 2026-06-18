import "./polymarket-app";

// In a terminal host (the Node agent, no DOM), register the Polymarket view so
// it renders inline in the terminal. Lazy + DOM-guarded so the terminal engine
// stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view")
    .then((m) => m.registerPolymarketTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}
