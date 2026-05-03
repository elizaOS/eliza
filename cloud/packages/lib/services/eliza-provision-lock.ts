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
