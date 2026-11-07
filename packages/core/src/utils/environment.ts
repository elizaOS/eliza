import { parseBooleanValue } from "./boolean.js";
import { normalizeEnvValue } from "./env.js";

/** Canonical environment-variable reader. */

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
	const env = options.env ?? process.env;
	return normalizeEnvValue(env[canonicalKey]) ?? options.defaultValue;
}

/** Boolean form of {@link readEnv}: truthy when the value is `1`/`true`/`yes`/`on`. */
export function readEnvBool(
	canonicalKey: string,
	options: Omit<ReadEnvOptions, "defaultValue"> & {
		defaultValue?: boolean;
	} = {},
): boolean {
	const raw = readEnv(canonicalKey, { env: options.env });
	return parseBooleanValue(raw) ?? options.defaultValue ?? false;
}

/** Canonical setting resolver: per-agent runtime setting first, then env. */

/**
 * Minimal structural shape of a runtime that can resolve a setting. Kept local
 * (rather than importing `IAgentRuntime`) to avoid coupling simple settings
 * consumers to the complete runtime type graph.
 */
export interface SettingReader {
	getSetting(key: string): string | boolean | number | null;
}

export type ResolveSettingOptions = ReadEnvOptions;

/**
 * Resolve a configuration value the way single-tenant / headless plugins want
 * it: the per-agent runtime setting first, then `process.env` as a deployment
 * fallback, then an optional default.
 *
 * This opt-in fallback must not be used for tenant settings in shared hosts.
 * AgentRuntime.getSetting stays agent-scoped and never reads process.env.
 *
 * Runtime values are coerced to string. The env fallback uses {@link readEnv}
 * semantics (trimmed; empty strings treated as unset).
 *
 * @param runtime - Runtime to read the per-agent setting from (may be null)
 * @param key - Setting / environment variable name
 * @param options - `defaultValue` and/or an explicit `env` record
 * @returns The resolved string, `options.defaultValue`, or `undefined`
 */
export function resolveSetting(
	runtime: SettingReader | null | undefined,
	key: string,
	options: ResolveSettingOptions = {},
): string | undefined {
	const fromRuntime = runtime?.getSetting(key);
	if (fromRuntime !== undefined && fromRuntime !== null) {
		return String(fromRuntime);
	}
	return readEnv(key, options);
}

/** Node environment access with explicit cache invalidation after settings reload. */

export class Environment {
	private readonly cache = new Map<string, string | undefined>();
	get(key: string, defaultValue?: string): string | undefined {
		if (!this.cache.has(key)) this.cache.set(key, process.env[key]);
		return this.cache.get(key) ?? defaultValue;
	}
	set(key: string, value: string | boolean | number): void {
		this.cache.delete(key);
		process.env[key] = String(value);
	}
	has(key: string): boolean {
		return this.get(key) !== undefined;
	}
	getAll(): Record<string, string | undefined> {
		return { ...process.env };
	}
	getBoolean(key: string, defaultValue = false): boolean {
		return parseBooleanValue(this.get(key)) ?? defaultValue;
	}
	getNumber(key: string, defaultValue?: number): number | undefined {
		const value = this.get(key)?.trim();
		if (!value) return defaultValue;
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : defaultValue;
	}
	clearCache(): void {
		this.cache.clear();
	}
}
const environment = new Environment();
export function getEnvironment(): Environment {
	return environment;
}
export function getEnv(key: string, defaultValue?: string): string | undefined {
	return environment.get(key, defaultValue);
}
export function setEnv(key: string, value: string | boolean | number): void {
	environment.set(key, value);
}
export function hasEnv(key: string): boolean {
	return environment.has(key);
}
export function getBooleanEnv(key: string, defaultValue = false): boolean {
	return environment.getBoolean(key, defaultValue);
}
export function getNumberEnv(
	key: string,
	defaultValue?: number,
): number | undefined {
	return environment.getNumber(key, defaultValue);
}
