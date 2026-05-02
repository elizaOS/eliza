/**
 * Eliza state-dir resolution.
 *
 * Canonical rule: `ELIZA_STATE_DIR` wins, then `<homedir>/.eliza`. Every
 * caller that wants to touch the persisted user state (skills, training,
 * optimized prompts, counters) must go through `resolveStateDir()` so we
 * have one place that enforces this precedence.
 *
 * Uses `os.homedir()` instead of `process.env.HOME` so the resolution works
 * on Windows where `HOME` is not normally set; `homedir()` returns a string
 * or throws.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the Eliza per-user state directory, honoring the documented
 * `ELIZA_STATE_DIR` → `~/.eliza` precedence.
 */
export function resolveStateDir(): string {
	return process.env.ELIZA_STATE_DIR?.trim() || join(homedir(), ".eliza");
}
