/**
 * Side-effect entry point — registers the Health view for terminal rendering.
 *
 * In a terminal host (the Node agent, no DOM), register the health view so it
 * renders inline in the terminal. Lazy + DOM-guarded so the terminal engine
 * stays out of browser/mobile bundles. Web, iOS, desktop, and Android leave
 * this a no-op (a DOM is present), so the same import is safe everywhere.
 */

import { logger } from "@elizaos/core";

if (typeof window === "undefined") {
  void import("./register-terminal-view.js")
    .then((m) => m.registerHealthTerminalView())
    .catch((error) => {
      // error-policy:J6 optional terminal-view registration; it runs at module
      // load with no runtime in scope to reportError, so the failure is recorded
      // via debug (diagnosable) and never blocks plugin load.
      logger.debug(
        { error: error instanceof Error ? error.message : String(error) },
        "[plugin-health] terminal view registration skipped",
      );
    });
}
