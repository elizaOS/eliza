/**
 * Canonical environment-variable reader with legacy-alias back-compat.
 *
 * The product runtime moved from the `MILADY_*` env-var convention to the
 * `ELIZA_*` convention. To avoid breaking existing installs, every read of a
 * renamed variable goes through {@link readEnv}, which:
 *
 *   1. Prefers the canonical (`ELIZA_*`) name.
 *   2. Falls back to each legacy alias in order, emitting a **one-time**
 *      deprecation `logger.warn` the first time a legacy alias is consulted.
 *   3. Returns `undefined` (or the supplied default) when none are set.
 *
 * Keeping the dual-read in one place means there is exactly one spot to remove
 * the back-compat shim when the deprecation window closes.
 */

import { logger } from "../logger.ts";

const warnedAliases = new Set<string>();

/** Process env, or an empty object in non-Node runtimes (browser). */
function defaultEnv(): NodeJS.ProcessEnv {
	return typeof process !== "undefined" && process.env
		? process.env
		: ({} as NodeJS.ProcessEnv);
}

/** Trim and treat empty strings as unset, matching dotenv semantics. */
function readRaw(env: NodeJS.ProcessEnv, key: string): string | undefined {
	const value = env[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export interface ReadEnvOptions {
	/** Environment object to read from. Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Value to return when neither the canonical name nor any alias is set. */
	defaultValue?: string;
	/**
	 * Suppress the one-time deprecation warning. Use only for internal tools
	 * that intentionally probe legacy names (e.g. migration code).
	 */
	silent?: boolean;
}

/**
 * Read `canonicalKey` from the environment, falling back to `legacyAliases`
 * (newest-preferred first) with a one-time deprecation warning per alias.
 */
export function readEnv(
	canonicalKey: string,
	legacyAliases: readonly string[] = [],
	options: ReadEnvOptions = {},
): string | undefined {
	const env = options.env ?? defaultEnv();
	const canonical = readRaw(env, canonicalKey);
	if (canonical !== undefined) return canonical;
	for (const alias of legacyAliases) {
		const value = readRaw(env, alias);
		if (value === undefined) continue;
		if (!options.silent && !warnedAliases.has(alias)) {
			warnedAliases.add(alias);
			logger.warn(
				`[env] "${alias}" is deprecated; use "${canonicalKey}" instead. The legacy name still works for now.`,
			);
		}
		return value;
	}
	return options.defaultValue;
}

/** Boolean form of {@link readEnv}: truthy when the value is `1`/`true`/`yes`/`on`. */
export function readEnvBool(
	canonicalKey: string,
	legacyAliases: readonly string[] = [],
	options: Omit<ReadEnvOptions, "defaultValue"> & {
		defaultValue?: boolean;
	} = {},
): boolean {
	const raw = readEnv(canonicalKey, legacyAliases, {
		env: options.env,
		silent: options.silent,
	});
	if (raw === undefined) return options.defaultValue ?? false;
	const normalized = raw.toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return options.defaultValue ?? false;
}

/** Test-only: reset the one-time-warning bookkeeping. */
export function __resetReadEnvWarnings(): void {
	warnedAliases.clear();
}
