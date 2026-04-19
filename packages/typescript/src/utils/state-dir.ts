/**
 * Milady state-dir resolution.
 *
 * Canonical rule: `MILADY_STATE_DIR` wins, then `ELIZA_STATE_DIR` (historical
 * alias), then `<homedir>/.milady`. Every caller that wants to touch the
 * persisted user state (skills, training, optimized prompts, counters) must
 * go through `resolveStateDir()` so we have one place that enforces this
 * precedence.
 *
 * Uses `os.homedir()` instead of `process.env.HOME` so the resolution works
 * on Windows where `HOME` is not normally set; `homedir()` returns a string
 * or throws.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the Milady per-user state directory, honoring the documented
 * `MILADY_STATE_DIR` → `ELIZA_STATE_DIR` → `~/.milady` precedence.
 */
export function resolveStateDir(): string {
	return (
		process.env.MILADY_STATE_DIR?.trim() ||
		process.env.ELIZA_STATE_DIR?.trim() ||
		join(homedir(), ".milady")
	);
}
