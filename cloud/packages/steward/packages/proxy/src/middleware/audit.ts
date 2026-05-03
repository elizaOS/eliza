/**
 * Audit logging for proxied requests.
 *
 * Logs every proxied request to the proxy_audit_log table in the database.
 * Designed for append-only, high-throughput logging with async writes
 * so audit never blocks the response path.
 */

import { getDb, proxyAuditLog } from "@stwd/db";

export interface AuditEntry {
  agentId: string;
  tenantId: string;
  targetHost: string;
  targetPath: string;
  method: string;
  statusCode: number;
  latencyMs: number;
}

/**
 * Record a proxy audit log entry.
 * Fires and forgets — audit failures are logged to stderr but never block the response.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    const db = getDb();
    await db.insert(proxyAuditLog).values({
      agentId: entry.agentId,
      tenantId: entry.tenantId,
      targetHost: entry.targetHost,
      targetPath: entry.targetPath,
      method: entry.method,
      statusCode: entry.statusCode,
      latencyMs: entry.latencyMs,
    });
  } catch (err) {
    // Never let audit logging break the proxy
    console.error("[audit] Failed to record audit entry:", err);
  }
}
