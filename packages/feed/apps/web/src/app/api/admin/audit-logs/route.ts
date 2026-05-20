/**
 * Admin Audit Logs API
 *
 * @route GET /api/admin/audit-logs - Get admin audit logs
 * @access Admin
 *
 * @description
 * Returns admin audit logs for reviewing admin actions.
 * Supports both offset-based and cursor-based pagination.
 * Cursor-based pagination is recommended for large datasets.
 *
 * @openapi
 * /api/admin/audit-logs:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get admin audit logs
 *     description: Returns admin audit logs with pagination (admin only). Supports both offset-based and cursor-based pagination.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 100
 *       - name: offset
 *         in: query
 *         description: Offset for offset-based pagination (max 1000). Use cursor for large datasets.
 *         schema:
 *           type: integer
 *           default: 0
 *           maximum: 1000
 *       - name: cursor
 *         in: query
 *         description: ISO timestamp cursor for cursor-based pagination. Use nextCursor from previous response.
 *         schema:
 *           type: string
 *           format: date-time
 *       - name: adminId
 *         in: query
 *         schema:
 *           type: string
 *       - name: action
 *         in: query
 *         schema:
 *           type: string
 *       - name: resourceType
 *         in: query
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Audit logs retrieved successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 */

import {
  errorResponse,
  requireAdmin,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import { adminAuditLogs, and, count, db, desc, eq, lt, users } from "@feed/db";
import { logger, toISO } from "@feed/shared";
import type { NextRequest } from "next/server";
import { z } from "zod";

// Audit log filters schema
// Action and resourceType accept any string value from the database
// to avoid validation mismatches when new resource types are logged
const AuditLogFiltersSchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(50),
  // Offset-based pagination (legacy, max 1000 to prevent performance issues)
  offset: z.coerce.number().min(0).max(1000).default(0),
  // Cursor-based pagination (recommended for large datasets)
  // Cursor is the ISO timestamp of the last item from previous page
  cursor: z.string().datetime().optional(),
  adminId: z.string().min(1).optional(),
  // Accept any action string to match database values dynamically
  action: z.string().min(1).max(64).optional(),
  // Accept any resource type string to match database values dynamically
  resourceType: z.string().min(1).max(64).optional(),
});

export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const { searchParams } = new URL(request.url);

  // Validate query parameters with Zod
  const parseResult = AuditLogFiltersSchema.safeParse({
    limit: searchParams.get("limit") || undefined,
    offset: searchParams.get("offset") || undefined,
    cursor: searchParams.get("cursor") || undefined,
    adminId: searchParams.get("adminId") || undefined,
    action: searchParams.get("action") || undefined,
    resourceType: searchParams.get("resourceType") || undefined,
  });

  if (!parseResult.success) {
    return errorResponse("Invalid query parameters", "VALIDATION_ERROR", 400, {
      details: parseResult.error.flatten(),
    });
  }

  const {
    limit,
    offset,
    cursor,
    adminId: filterAdminId,
    action: filterAction,
    resourceType: filterResourceType,
  } = parseResult.data;

  // Determine pagination mode (cursor-based preferred for performance)
  const useCursorPagination = !!cursor;

  logger.info(
    "Admin audit logs requested",
    {
      limit,
      offset: useCursorPagination ? undefined : offset,
      cursor: useCursorPagination ? cursor : undefined,
      filterAdminId,
      filterAction,
      filterResourceType,
      paginationMode: useCursorPagination ? "cursor" : "offset",
    },
    "GET /api/admin/audit-logs",
  );

  // Build filter conditions (not cursor)
  const filterConditions: ReturnType<typeof eq>[] = [];
  if (filterAdminId) {
    filterConditions.push(eq(adminAuditLogs.adminId, filterAdminId));
  }
  if (filterAction) {
    filterConditions.push(eq(adminAuditLogs.action, filterAction));
  }
  if (filterResourceType) {
    filterConditions.push(eq(adminAuditLogs.resourceType, filterResourceType));
  }

  const filterCondition =
    filterConditions.length > 0 ? and(...filterConditions) : undefined;

  // Get total count for proper pagination (only needed for offset-based)
  let total = 0;
  if (!useCursorPagination) {
    const [totalResult] = await db
      .select({ count: count() })
      .from(adminAuditLogs)
      .where(filterCondition);
    total = totalResult?.count ?? 0;
  }

  // Build full query conditions including cursor
  const queryConditions = [...filterConditions];
  if (cursor) {
    // Cursor is the createdAt timestamp of the last item - get items older than cursor
    queryConditions.push(lt(adminAuditLogs.createdAt, new Date(cursor)));
  }
  const whereCondition =
    queryConditions.length > 0 ? and(...queryConditions) : undefined;

  // Query logs with admin user info
  // PERFORMANCE NOTE: For optimal query performance, ensure the database has a composite index:
  // CREATE INDEX idx_admin_audit_logs_filters ON admin_audit_logs (admin_id, action, resource_type, created_at DESC);
  // This supports the common filter patterns (adminId, action, resourceType) while also optimizing ORDER BY createdAt DESC
  const logs = await db
    .select({
      id: adminAuditLogs.id,
      adminId: adminAuditLogs.adminId,
      action: adminAuditLogs.action,
      resourceType: adminAuditLogs.resourceType,
      resourceId: adminAuditLogs.resourceId,
      previousValue: adminAuditLogs.previousValue,
      newValue: adminAuditLogs.newValue,
      ipAddress: adminAuditLogs.ipAddress,
      metadata: adminAuditLogs.metadata,
      createdAt: adminAuditLogs.createdAt,
      adminUsername: users.username,
      adminDisplayName: users.displayName,
      adminProfileImageUrl: users.profileImageUrl,
    })
    .from(adminAuditLogs)
    .leftJoin(users, eq(adminAuditLogs.adminId, users.id))
    .where(whereCondition)
    .orderBy(desc(adminAuditLogs.createdAt))
    .limit(limit + 1) // Fetch one extra to determine if there are more
    .offset(useCursorPagination ? 0 : offset);

  // Determine if there are more results
  const hasMore = logs.length > limit;
  const resultLogs = hasMore ? logs.slice(0, limit) : logs;

  // Generate next cursor from the last item
  const lastLog = resultLogs[resultLogs.length - 1];
  const nextCursor = hasMore && lastLog ? toISO(lastLog.createdAt) : null;

  // Get unique action types for filter dropdown
  const actionTypes = await db
    .selectDistinct({ action: adminAuditLogs.action })
    .from(adminAuditLogs)
    .orderBy(adminAuditLogs.action);

  // Get unique resource types for filter dropdown
  const resourceTypes = await db
    .selectDistinct({ resourceType: adminAuditLogs.resourceType })
    .from(adminAuditLogs)
    .orderBy(adminAuditLogs.resourceType);

  return successResponse({
    logs: resultLogs.map((log) => ({
      ...log,
      createdAt: toISO(log.createdAt),
      admin: {
        id: log.adminId,
        username: log.adminUsername,
        displayName: log.adminDisplayName,
        profileImageUrl: log.adminProfileImageUrl,
      },
    })),
    pagination: {
      limit,
      // Offset-based pagination fields (for backwards compatibility)
      offset: useCursorPagination ? undefined : offset,
      total: useCursorPagination ? undefined : total,
      // Cursor-based pagination fields (preferred for large datasets)
      cursor: useCursorPagination ? cursor : undefined,
      nextCursor,
      hasMore,
    },
    filters: {
      actionTypes: actionTypes.map((a) => a.action),
      resourceTypes: resourceTypes.map((r) => r.resourceType),
    },
  });
});
