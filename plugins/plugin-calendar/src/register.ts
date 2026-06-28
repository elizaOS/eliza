/**
 * Side-effect entry point — registers the calendar view for terminal rendering.
 *
 * In a terminal host (the Node agent, no DOM), register the calendar view so it
 * renders inline in the terminal. Lazy + DOM-guarded so the terminal engine
 * stays out of browser/mobile bundles; on a DOM host this module is inert.
 */

if (typeof window === "undefined") {
  void import("./register-terminal-view.js")
    .then((m) => m.registerCalendarTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}
