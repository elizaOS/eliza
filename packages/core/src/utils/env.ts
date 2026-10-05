/**
 * Environment-value normalization and explicit alias resolution.
 */

/**
 * Normalize an env value: trim whitespace, return `undefined` for empty/missing.
 * Accepts `unknown` so callers don't need to narrow first (useful for config objects).
 */
export function normalizeEnvValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

/**
 * Same as `normalizeEnvValue` but returns `null` instead of `undefined`.
 * Convenient when building option objects where `null` means "absent".
 */
export function normalizeEnvValueOrNull(value: unknown): string | null {
	return normalizeEnvValue(value) ?? null;
}

/**
 * Returns `true` if a boolean-ish env var is falsy (`"0"`, `"false"`, `"off"`, `"no"`).
 * Missing or empty values return `false` (i.e. the feature is enabled by default).
 */
export function isEnvDisabled(value: string | undefined): boolean {
	const raw = value?.trim().toLowerCase();
	if (!raw) return false;
	return raw === "0" || raw === "false" || raw === "off" || raw === "no";
}

/**
 * Authorization predicate for dangerous operator opt-ins whose documented
 * value is exactly `true`, such as `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS`.
 * Deliberately strict — unlike {@link parseBooleanValue}, `"1"`, `"yes"`, and
 * `"on"` authorize nothing — so capability gates, restore guards, and boot
 * warnings all evaluate the same operator decision. Loosen only with a
 * coordinated change across every reader of the flag.
 */
export function isExactTrueEnvFlag(value: string | undefined): boolean {
	return value === "true";
}

/** Resolve an explicit alias table without mutating the supplied environment. */
export function resolveEnvAlias(
	key: string,
	aliases: readonly (readonly [string, string])[] | undefined,
	env: Record<string, string | undefined> | null,
): string | undefined {
	if (!env) return undefined;
	if (env[key]?.trim()) return env[key];
	for (const [left, right] of aliases ?? []) {
		const partner = left === key ? right : right === key ? left : undefined;
		if (partner !== undefined && env[partner]?.trim()) return env[partner];
	}
	return undefined;
}
