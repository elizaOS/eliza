// Coordinates cloud service eliza provision lock behavior behind route handlers.
import { sql } from "drizzle-orm";

/**
 * Per-agent lifecycle advisory lock shared by enqueue/delete/shutdown paths.
 *
 * Use the two-key form instead of hashing a concatenated string into a single
 * int4 so the lock space is effectively 64 bits (two independent 32-bit keys).
 */
export function elizaProvisionAdvisoryLockSql(organizationId: string, agentId: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}), hashtext(${agentId}))`;
}

/**
 * Per-organization coding-container image lock. This serializes the idempotent
 * "one active sandbox per image" creation path without constraining warm-pool
 * rows or unrelated custom-image agents at the schema level.
 */
export function elizaCodingContainerImageAdvisoryLockSql(organizationId: string, image: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}), hashtext(${`coding-container:${image}`}))`;
}

/**
 * Per-organization agent-create lock. Serializes the idempotent createAgent
 * path so two near-simultaneous creates for the same org can't each mint a
 * fresh sandbox (each = a container + per-tenant DB + ingress). Keyed on the
 * org only — unlike the coding-container lock it deliberately ignores the
 * image so it serializes ALL standard creates for the org. The fixed second
 * key keeps the same two-int4 form as the other helpers.
 */
export function elizaAgentCreateAdvisoryLockSql(organizationId: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}), hashtext(${"agent-create"}))`;
}

/**
 * Per-source-agent tier-upgrade lock. The target service holds this across its
 * durable re-check and initial insert so concurrent requests can only observe
 * and reattach to the first request's target.
 */
export function elizaAgentTierUpgradeAdvisoryLockSql(
  organizationId: string,
  sharedAgentId: string,
) {
  return sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}), hashtext(${`tier-upgrade:${sharedAgentId}`}))`;
}
