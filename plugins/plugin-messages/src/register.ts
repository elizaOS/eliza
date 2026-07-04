/**
 * Side-effect module: on a terminal host (the Node agent, no DOM) registers the
 * Messages view so it renders inline in the terminal. The import is lazy and
 * DOM-guarded so the terminal engine stays out of browser/mobile bundles.
 */
if (typeof window === "undefined") {
  void import("./register-terminal-view")
    .then((m) => m.registerMessagesTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}

// Only a dynamic import remains above; keep this file a module so
// `export * from "./register"` (src/index.ts) does not hit TS2306.
export {};
