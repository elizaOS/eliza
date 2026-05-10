/**
 * Eliza state-dir resolution.
 *
 * Canonical precedence (highest first):
 *   1. `MILADY_STATE_DIR`
 *   2. `ELIZA_STATE_DIR`
 *   3. `<homedir>/.${ELIZA_NAMESPACE ?? "eliza"}`
 *
 * Every caller that touches persisted user state (skills, training,
 * optimized prompts, counters, credentials) must go through
 * `resolveStateDir()` so the precedence is enforced in one place.
 *
 * Uses `os.homedir()` rather than `process.env.HOME` so resolution works
 * on Windows where `HOME` is not normally set, and so that under macOS
 * App Sandbox / Windows AppContainer / Flatpak the OS-redirected home
 * already lands paths in the per-app sandboxed data directory.
 */

import { cp, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Expand a leading `~` segment and resolve to an absolute path. */
export function resolveUserPath(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.startsWith("~")) {
		return resolve(trimmed.replace(/^~(?=$|[\\/])/, homedir()));
	}
	return resolve(trimmed);
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
	const value = env[key]?.trim();
	return value && value.length > 0 ? value : undefined;
}

/**
 * Resolve the active namespace used to derive the default state directory
 * (`~/.${namespace}`). Defaults to `"eliza"`.
 */
export function getElizaNamespace(
	env: NodeJS.ProcessEnv = process.env,
): string {
	return readEnv(env, "ELIZA_NAMESPACE") ?? "eliza";
}

/**
 * Resolve the per-user state directory, honoring the documented precedence:
 * `MILADY_STATE_DIR` > `ELIZA_STATE_DIR` > `~/.${ELIZA_NAMESPACE ?? "eliza"}`.
 */
export function resolveStateDir(
	env: NodeJS.ProcessEnv = process.env,
	getHome: () => string = homedir,
): string {
	const explicit = readEnv(env, "MILADY_STATE_DIR") ?? readEnv(env, "ELIZA_STATE_DIR");
	if (explicit) return resolveUserPath(explicit);
	return join(getHome(), `.${getElizaNamespace(env)}`);
}

/**
 * Resolve the OAuth credentials directory. Honors `ELIZA_OAUTH_DIR`;
 * otherwise falls back to `<state-dir>/credentials`.
 */
export function resolveOAuthDir(
	env: NodeJS.ProcessEnv = process.env,
	stateDirPath: string = resolveStateDir(env),
): string {
	const explicit = readEnv(env, "ELIZA_OAUTH_DIR");
	return explicit ? resolveUserPath(explicit) : join(stateDirPath, "credentials");
}

/**
 * Recursively copy `fromPath` into `toPath`. Idempotent — re-runs are safe.
 * No-op when the source does not exist. Used by the user-initiated
 * "import from direct build" flow to migrate state into a sandboxed
 * store-build state directory.
 */
export async function migrateStateDir(
	fromPath: string,
	toPath: string,
): Promise<{ migrated: boolean }> {
	if (fromPath === toPath) return { migrated: false };
	try {
		const srcStat = await stat(fromPath);
		if (!srcStat.isDirectory()) return { migrated: false };
	} catch {
		return { migrated: false };
	}
	await mkdir(toPath, { recursive: true });
	await cp(fromPath, toPath, {
		recursive: true,
		force: false,
		errorOnExist: false,
		dereference: false,
	});
	return { migrated: true };
}
