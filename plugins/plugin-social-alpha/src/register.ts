/**
 * Side-effect entry point — registers the Social Alpha view for terminal
 * rendering.
 *
 * In a terminal host (the Node agent, no DOM), register the leaderboard view so
 * it renders inline in the terminal. Lazy + DOM-guarded so the terminal engine
 * stays out of browser/mobile bundles. Web, iOS, desktop, and Android leave this
 * a no-op (a DOM is present), so the same import is safe everywhere.
 */

import { logger } from "@elizaos/core";

if (typeof window === "undefined") {
	void import("./register-terminal-view.js")
		.then((m) => m.registerSocialAlphaTerminalView())
		// error-policy:J5 optional terminal-view registration; suppression is observed via this debug log and never blocks plugin load
		.catch((err) => {
			logger.debug(`[social-alpha] Terminal view registration skipped: ${err}`);
		});
}
