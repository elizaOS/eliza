/** Canonical environment-variable reader. */

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
