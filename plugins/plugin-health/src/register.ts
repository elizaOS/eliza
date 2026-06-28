/**
 * Side-effect entry point — registers the Health view for terminal rendering.
 *
 * In a terminal host (the Node agent, no DOM), register the health view so it
 * renders inline in the terminal. Lazy + DOM-guarded so the terminal engine
 * stays out of browser/mobile bundles. Web, iOS, desktop, and Android leave
 * this a no-op (a DOM is present), so the same import is safe everywhere.
 */

if (typeof window === "undefined") {
  void import("./register-terminal-view.js")
    .then((m) => m.registerHealthTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}
