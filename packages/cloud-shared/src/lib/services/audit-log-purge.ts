/**
 * Audit-log retention purge (D-4).
 *
 * Deletes rows from `secret_audit_log` whose `expires_at` is in the past.
 * Default retention is 7 years (set by the column default), so under
 * normal operation this job is a no-op until rows actually age out.
 * Writers may set a shorter `expires_at` per row (e.g. dev events) and
 * those will be reaped here.
 */

import { lt } from "drizzle-orm";
import { dbWrite } from "../../db/client";
import { secretAuditLog } from "../../db/schemas/secrets";
import { logger } from "../utils/logger";

export interface AuditLogPurgeResult {
  deleted: number;
}

export async function purgeExpiredAuditLog(): Promise<AuditLogPurgeResult> {
  const now = new Date();
  const deleted = await dbWrite
    .delete(secretAuditLog)
    .where(lt(secretAuditLog.expires_at, now))
    .returning({ id: secretAuditLog.id });
  const count = deleted.length;
  logger.info("[AuditLogPurge] purged expired audit rows", { count });
  return { deleted: count };
}
