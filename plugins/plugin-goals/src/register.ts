/**
 * Side-effect entry point — registers the goals view for terminal rendering.
 *
 * In a terminal host (the Node agent, no DOM) this registers the unified goals
 * view so it renders inline in the terminal. Lazy + DOM-guarded so the terminal
 * engine stays out of browser/mobile bundles. Load this module once during app
 * startup; in a browser/mobile host it is a no-op.
 */

if (typeof window === "undefined") {
  void import("./register-terminal-view.tsx")
    .then((m) => m.registerGoalsTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}
