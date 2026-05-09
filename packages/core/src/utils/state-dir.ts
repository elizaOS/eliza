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
import { join, resolve } from "node:path";

/**
 * Resolve the Eliza per-user state directory, honoring the documented
 * `ELIZA_STATE_DIR` → `~/.eliza` precedence.
 */
export function resolveUserPath(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.startsWith("~")) {
		return resolve(trimmed.replace(/^~(?=$|[\\/])/, homedir()));
	}
	return resolve(trimmed);
}

export function resolveStateDir(
	env: NodeJS.ProcessEnv = process.env,
	getHome: () => string = homedir,
): string {
	const explicit = env.ELIZA_STATE_DIR?.trim();
	return explicit ? resolveUserPath(explicit) : join(getHome(), ".eliza");
}

export function resolveOAuthDir(
	env: NodeJS.ProcessEnv = process.env,
	stateDirPath: string = resolveStateDir(env),
): string {
	const explicit = env.ELIZA_OAUTH_DIR?.trim();
	return explicit ? resolveUserPath(explicit) : join(stateDirPath, "credentials");
}
