/**
 * Audit-log retention purge (D-4).
 *
 * Deletes rows from `secret_audit_log` and `auth_events` whose `expires_at`
 * is in the past. Default retention is 7 years (set by each column default),
 * so under normal operation this job is a no-op until rows actually age out.
 * Writers may set a shorter `expires_at` per row (e.g. dev events) and those
 * will be reaped here.
 */

import { lt } from "drizzle-orm";
import { dbWrite } from "../../db/client";
import { authEvents } from "../../db/schemas/auth-events";
import { secretAuditLog } from "../../db/schemas/secrets";
import { logger } from "../utils/logger";

export interface AuditLogPurgeResult {
  /** Total rows removed across every audit table. */
  deleted: number;
  secretAuditDeleted: number;
  authEventsDeleted: number;
}

export async function purgeExpiredAuditLog(now: Date = new Date()): Promise<AuditLogPurgeResult> {
  const secretRows = await dbWrite
    .delete(secretAuditLog)
    .where(lt(secretAuditLog.expires_at, now))
    .returning({ id: secretAuditLog.id });
  const authRows = await dbWrite
    .delete(authEvents)
    .where(lt(authEvents.expires_at, now))
    .returning({ id: authEvents.event_id });
  const result: AuditLogPurgeResult = {
    deleted: secretRows.length + authRows.length,
    secretAuditDeleted: secretRows.length,
    authEventsDeleted: authRows.length,
  };
  logger.info("[AuditLogPurge] purged expired audit rows", result);
  return result;
}
