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
 * Per-source-agent tier-upgrade lock. The target service holds this across
 * the durable re-check, the target insert, AND the provision-job enqueue
 * (one transaction, #15943) so concurrent requests can only observe and
 * reattach to the first request's committed target-plus-job.
 *
 * Global lock order (strict, deadlock-free): org agent-create lock →
 * this per-source lock → per-agent provision lock. The tier-upgrade
 * transaction takes the ORG lock first so its quota count→insert is atomic
 * against createAgent / coding-container creates and against upgrades of a
 * DIFFERENT source agent (which hold a different per-source key); no path
 * acquires these locks in any other order.
 */
export function elizaAgentTierUpgradeAdvisoryLockSql(
  organizationId: string,
  sharedAgentId: string,
) {
  return sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}), hashtext(${`tier-upgrade:${sharedAgentId}`}))`;
}
