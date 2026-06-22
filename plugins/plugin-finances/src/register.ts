/**
 * Side-effect entry point — registers the Finances view for terminal rendering.
 *
 * In a terminal host (the Node agent, no DOM), register the finances view so it
 * renders inline in the terminal. Lazy + DOM-guarded so the terminal engine
 * stays out of browser/mobile bundles. Web, iOS, desktop, and Android leave
 * this a no-op (a DOM is present), so the same import is safe everywhere.
 */

if (typeof window === "undefined") {
  void import("./register-terminal-view.js")
    .then((m) => m.registerFinancesTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}
