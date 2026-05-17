import type { ConnectorAccount } from "./account-manager";

/**
 * Canonical privacy levels for connector accounts.
 *
 * Stored on `account.metadata.privacy`. Defaults to `owner_only` when missing.
 *
 * - `owner_only` (default): only OWNER role users may see this account's data
 *   in surfaced summaries, providers, and contexts.
 * - `team_visible`: OWNER + TEAM/ADMIN roles may see.
 * - `semi_public`: anyone interacting with the agent may see.
 * - `public`: broadcast-eligible (agent may post publicly mentioning data
 *   from this account).
 */
export type PrivacyLevel =
	| "owner_only"
	| "team_visible"
	| "semi_public"
	| "public";

export const PRIVACY_LEVELS: PrivacyLevel[] = [
	"owner_only",
	"team_visible",
	"semi_public",
	"public",
];

export const DEFAULT_PRIVACY_LEVEL: PrivacyLevel = "owner_only";

const PRIVACY_LEVEL_RANK: Record<PrivacyLevel, number> = {
	owner_only: 0,
	team_visible: 1,
	semi_public: 2,
	public: 3,
};

/**
 * Returns true when `actual` is at least as permissive as `required`.
 *
 * Levels are ordered owner_only=0, team_visible=1, semi_public=2, public=3
 * and the comparison is `actual >= required`.
 */
export function privacyAtLeast(
	actual: PrivacyLevel,
	required: PrivacyLevel,
): boolean {
	return PRIVACY_LEVEL_RANK[actual] >= PRIVACY_LEVEL_RANK[required];
}

/**
 * Type guard for arbitrary string values, returning true only for canonical
 * `PrivacyLevel` values.
 */
export function isPrivacyLevel(value: unknown): value is PrivacyLevel {
	return (
		typeof value === "string" &&
		(PRIVACY_LEVELS as readonly string[]).includes(value)
	);
}

/**
 * Resolve an account's privacy level from `account.metadata.privacy`.
 *
 * Defaults fail-safe to `owner_only` when the field is missing or the stored
 * value is not a canonical `PrivacyLevel`.
 */
export function getAccountPrivacy(account: ConnectorAccount): PrivacyLevel {
	const raw = account.metadata?.privacy;
	return isPrivacyLevel(raw) ? raw : DEFAULT_PRIVACY_LEVEL;
}
