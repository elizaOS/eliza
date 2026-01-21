/**
 * Admin Audit Logger
 *
 * @description Logs admin actions for audit trail and debugging purposes.
 * All admin API operations should log their actions through this utility.
 * Actions are logged to both the console (for immediate visibility) and
 * the AdminAuditLog database table (for persistence and reporting).
 */

import { adminAuditLogs, db } from "@polyagent/db";
import { generateSnowflakeId, logger } from "@polyagent/shared";
import type { JsonValue } from "./types";

export interface AdminAuditContext {
  /** Admin user ID performing the action */
  adminId: string;
  /** IP address of the request (if available) */
  ipAddress?: string;
  /** User agent of the request (if available) */
  userAgent?: string;
  /** Target resource type (e.g., 'group', 'user', 'message') */
  resourceType: string;
  /** Target resource ID */
  resourceId?: string;
  /** Previous value before modification */
  previousValue?: JsonValue;
  /** New value after modification */
  newValue?: JsonValue;
  /** Additional context data - must be JSON-serializable */
  metadata?: JsonValue;
}

/**
 * Log an admin action for audit purposes.
 * Logs to both console and database for redundancy.
 */
export async function logAdminAction(
  action: string,
  context: AdminAuditContext,
): Promise<void> {
  const timestamp = new Date().toISOString();

  // Log to console immediately
  logger.info(
    `[ADMIN_AUDIT] ${action}`,
    {
      action,
      adminId: context.adminId,
      ipAddress: context.ipAddress,
      resourceType: context.resourceType,
      resourceId: context.resourceId,
      timestamp,
    },
    "AdminAudit",
  );

  // Persist to database asynchronously (don't block on this)
  void persistAuditLog(action, context);
}

/**
 * Persist audit log to database
 * Silently fails if the AdminAuditLog table doesn't exist (migration not yet applied)
 */
async function persistAuditLog(
  action: string,
  context: AdminAuditContext,
): Promise<void> {
  const id = await generateSnowflakeId();

  await db
    .insert(adminAuditLogs)
    .values({
      id,
      adminId: context.adminId,
      action,
      resourceType: context.resourceType,
      resourceId: context.resourceId ?? null,
      previousValue: context.previousValue ?? null,
      newValue: context.newValue ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      metadata: context.metadata ?? null,
    })
    .catch((err: Error) => {
      // Log but don't throw - table might not exist yet (migration not applied)
      logger.warn(
        `Failed to persist audit log: ${err.message}`,
        { action, resourceType: context.resourceType },
        "AdminAudit",
      );
    });
}

/**
 * Log admin viewing/reading a resource
 */
export async function logAdminView(context: AdminAuditContext): Promise<void> {
  await logAdminAction("VIEW", context);
}

/**
 * Log admin modifying a resource
 */
export async function logAdminModify(
  context: AdminAuditContext,
): Promise<void> {
  await logAdminAction("MODIFY", context);
}

/**
 * Log admin deleting a resource
 */
export async function logAdminDelete(
  context: AdminAuditContext,
): Promise<void> {
  await logAdminAction("DELETE", context);
}

/**
 * Log admin creating a resource
 */
export async function logAdminCreate(
  context: AdminAuditContext,
): Promise<void> {
  await logAdminAction("CREATE", context);
}

/**
 * Log admin ban/unban action
 */
export async function logAdminBan(
  context: AdminAuditContext & { isBan: boolean },
): Promise<void> {
  await logAdminAction(context.isBan ? "BAN" : "UNBAN", context);
}

/**
 * Log admin promoting/demoting another admin
 */
export async function logAdminPrivilegeChange(
  context: AdminAuditContext & { isPromotion: boolean },
): Promise<void> {
  await logAdminAction(
    context.isPromotion ? "PROMOTE_ADMIN" : "DEMOTE_ADMIN",
    context,
  );
}

// Re-export getClientIp from utils for convenience
export { getClientIp } from "./utils";
