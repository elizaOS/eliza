/** Canonical environment-variable reader. */

import { ElizaError } from "../errors.ts";
import { parseBooleanValue } from "./boolean.js";

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
	/** Value to return when the canonical name is not set. */
	defaultValue?: string;
}

export function readEnv(
	canonicalKey: string,
	options: ReadEnvOptions = {},
): string | undefined {
	const env = options.env ?? defaultEnv();
	return readRaw(env, canonicalKey) ?? options.defaultValue;
}

/** Boolean form of {@link readEnv}: truthy when the value is `1`/`true`/`yes`/`on`. */
export function readEnvBool(
	canonicalKey: string,
	options: Omit<ReadEnvOptions, "defaultValue"> & {
		defaultValue?: boolean;
	} = {},
): boolean {
	const raw = readEnv(canonicalKey, { env: options.env });
	// `parseBooleanValue`'s default sets are exactly `1/true/yes/on` (truthy) and
	// `0/false/no/off` (falsy) — identical to this reader's historical inline
	// lists — so it preserves behavior. Unset or unrecognized values fall back
	// to `defaultValue` (default `false`), matching the previous semantics.
	return parseBooleanValue(raw) ?? options.defaultValue ?? false;
}

export interface ReadEnvNumberOptions
	extends Omit<ReadEnvOptions, "defaultValue"> {
	/** Default numeric value when the key is unset. */
	defaultValue?: number;
	/** Optional lower bound (inclusive). */
	min?: number;
	/** Optional upper bound (inclusive). */
	max?: number;
}

/**
 * Numeric form of {@link readEnv}: returns the parsed finite number or defaultValue.
 *
 * @throws {ElizaError} If the environment variable is set but cannot be parsed as a finite number,
 * or falls outside [min, max] bounds.
 */
export function readEnvNumber(
	canonicalKey: string,
	options: ReadEnvNumberOptions = {},
): number | undefined {
	const raw = readEnv(canonicalKey, { env: options.env });
	if (raw === undefined) return options.defaultValue;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) {
		throw new ElizaError(
			`Invalid numeric environment variable ${canonicalKey}: "${raw}"`,
			{
				code: "INVALID_ENV_VALUE",
				context: { key: canonicalKey, value: raw },
			},
		);
	}
	if (options.min !== undefined && parsed < options.min) {
		throw new ElizaError(
			`Numeric environment variable ${canonicalKey} (${parsed}) is below minimum ${options.min}`,
			{
				code: "INVALID_ENV_VALUE",
				context: { key: canonicalKey, value: raw, min: options.min },
			},
		);
	}
	if (options.max !== undefined && parsed > options.max) {
		throw new ElizaError(
			`Numeric environment variable ${canonicalKey} (${parsed}) is above maximum ${options.max}`,
			{
				code: "INVALID_ENV_VALUE",
				context: { key: canonicalKey, value: raw, max: options.max },
			},
		);
	}
	return parsed;
}

/**
 * Read the first set environment variable among an ordered list of fallback keys.
 *
 * Note: this helper does literal key lookups and is NOT intended for brand/white-label
 * alias resolution (use `resolveAliasedEnvValue` for keys defined in `BRAND_ENV_ALIAS_DEFINITIONS`).
 */
export function readEnvFirst(
	keys: string[],
	options: ReadEnvOptions = {},
): string | undefined {
	for (const key of keys) {
		const val = readEnv(key, { env: options.env });
		if (val !== undefined) {
			return val;
		}
	}
	return options.defaultValue;
}
