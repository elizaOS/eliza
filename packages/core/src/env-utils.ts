/**
 * Canonical environment-variable truthiness check.
 *
 * Pure string logic with no Node-only dependencies, so it is safe in the
 * browser bundle and is exported from both the node and browser barrels. This
 * is the single source of truth for env-flag truthiness across the workspace;
 * `@elizaos/shared` re-exports it so browser consumers share the same set.
 */
const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "y", "on", "enabled"]);

export function isTruthyEnvValue(value: string | undefined | null): boolean {
	if (typeof value !== "string") return false;
	const normalized = value.trim().toLowerCase();
	if (!normalized) return false;
	return TRUTHY_ENV_VALUES.has(normalized);
}
