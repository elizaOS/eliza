/**
 * Eliza state-dir resolution.
 *
 * Canonical precedence (highest first):
 *   1. `ELIZA_STATE_DIR` (legacy `MILADY_STATE_DIR` still honored, with a
 *      one-time deprecation warning)
 *   2. `<homedir>/.${ELIZA_NAMESPACE ?? "eliza"}`
 *
 * Every caller that touches persisted user state (skills, training,
 * optimized prompts, counters, credentials) must go through
 * `resolveStateDir()` so the precedence is enforced in one place.
 *
 * Uses `os.homedir()` rather than `process.env.HOME` so resolution works
 * on Windows where `HOME` is not normally set, and so that under macOS
 * App Sandbox / Windows AppContainer / Flatpak the OS-redirected home
 * already lands paths in the per-app sandboxed data directory.
 *
 * On first run, if the default `~/.eliza` directory does not exist but a
 * legacy `~/.milady` directory does, {@link migrateLegacyStateDir} copies
 * its contents over so existing installs keep working. Run it once at boot.
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { cp, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { logger } from "../logger.ts";
import { readEnv } from "./read-env.ts";

/** Legacy default state-directory name (pre-`MILADY`→`ELIZA` rename). */
const LEGACY_NAMESPACE = "milady";

/** Expand a leading `~` segment and resolve to an absolute path. */
export function resolveUserPath(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.startsWith("~")) {
		return resolve(trimmed.replace(/^~(?=$|[\\/])/, homedir()));
	}
	return resolve(trimmed);
}

/**
 * Resolve the active namespace used to derive the default state directory
 * (`~/.${namespace}`). Defaults to `"eliza"`.
 */
export function getElizaNamespace(
	env: NodeJS.ProcessEnv = process.env,
): string {
	return readEnv("ELIZA_NAMESPACE", [], { env }) ?? "eliza";
}

/**
 * Resolve the per-user state directory, honoring the documented precedence:
 * `ELIZA_STATE_DIR` (legacy `MILADY_STATE_DIR` honored) > `~/.${ELIZA_NAMESPACE ?? "eliza"}`.
 */
export function resolveStateDir(
	env: NodeJS.ProcessEnv = process.env,
	getHome: () => string = homedir,
): string {
	const explicit = readEnv("ELIZA_STATE_DIR", ["MILADY_STATE_DIR"], { env });
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
	const explicit = readEnv("ELIZA_OAUTH_DIR", [], { env });
	return explicit
		? resolveUserPath(explicit)
		: join(stateDirPath, "credentials");
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

/**
 * One-time legacy state-dir migration: when the resolved state dir is the
 * default `~/.eliza` (no explicit `ELIZA_STATE_DIR`/`MILADY_STATE_DIR`,
 * default namespace), the new dir does not yet exist, and a legacy
 * `~/.milady` dir does, copy the legacy contents into `~/.eliza` and log it
 * once. Synchronous so it can run before any state-dir reads at boot.
 *
 * No-op when an explicit state dir is set, a non-default namespace is in use,
 * or `~/.eliza` already exists.
 */
export function migrateLegacyStateDir(
	env: NodeJS.ProcessEnv = process.env,
	getHome: () => string = homedir,
): { migrated: boolean; from?: string; to?: string } {
	// Explicit override → never migrate.
	if (readEnv("ELIZA_STATE_DIR", ["MILADY_STATE_DIR"], { env, silent: true })) {
		return { migrated: false };
	}
	const namespace = getElizaNamespace(env);
	if (namespace === LEGACY_NAMESPACE) return { migrated: false };
	const home = getHome();
	const newDir = join(home, `.${namespace}`);
	const legacyDir = join(home, `.${LEGACY_NAMESPACE}`);
	if (existsSync(newDir)) return { migrated: false };
	if (!existsSync(legacyDir)) return { migrated: false };
	try {
		mkdirSync(newDir, { recursive: true });
		cpSync(legacyDir, newDir, {
			recursive: true,
			force: false,
			errorOnExist: false,
			dereference: false,
		});
		logger.warn(
			`[state-dir] migrated legacy state from "${legacyDir}" to "${newDir}". The old directory is left in place; you may remove it once you've confirmed the migration.`,
		);
		return { migrated: true, from: legacyDir, to: newDir };
	} catch (err) {
		logger.warn(
			`[state-dir] failed to migrate legacy state from "${legacyDir}" to "${newDir}": ${
				err instanceof Error ? err.message : String(err)
			}. Continuing with a fresh "${newDir}".`,
		);
		return { migrated: false, from: legacyDir, to: newDir };
	}
}
