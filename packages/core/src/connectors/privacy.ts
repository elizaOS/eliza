/**
 * Privacy-level vocabulary for connector accounts — the
 * ordered `owner_only < team_visible < semi_public < public` scale that gates
 * whether an account's data may surface in providers, summaries, and public
 * posts. Stored on `account.metadata.privacy`; consumed alongside the
 * role/access-gate checks in `account-manager.ts`.
 */
import type { ConnectorAccount } from "./account-manager";

/**
 * Canonical privacy levels for connector accounts.
 *
 * Stored on `account.metadata.privacy`. Defaults to `owner_only` when missing.
 *
 * - `owner_only` (default): only OWNER role users may see this account's data
 * in surfaced summaries, providers, and contexts.
 * - `team_visible`: OWNER + TEAM/ADMIN roles may see.
 * - `semi_public`: anyone interacting with the agent may see.
 * - `public`: broadcast-eligible (agent may post publicly mentioning data
 * from this account).
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
