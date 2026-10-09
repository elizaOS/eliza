/**
 * Called after shutdown cleanup completes in the fatal startup error path.
 * Must use Utils.quit() — not process.exit() — so CEF/native destructors
 * run to completion.
 */
import { Utils } from "electrobun/bun";

export function shutdownAfterFatalError(): void {
	Utils.quit();
}
