// GET /api/admin/roles - List admins
// POST /api/admin/roles - Grant/revoke roles (SUPER_ADMIN only)

import {
  applyRateLimit,
  errorResponse,
  getAllAdmins,
  RATE_LIMIT_CONFIGS,
  rateLimitError,
  requireAdmin,
  requireSuperAdmin,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import {
  ADMIN_PERMISSIONS,
  ADMIN_ROLES,
  type AdminPermission,
  type AdminRoleType,
  adminRoles,
  and,
  db,
  eq,
  generateSnowflakeId,
  isNull,
  ROLE_PERMISSIONS,
  sql,
  users,
} from "@feed/db";
import { logger, toISO } from "@feed/shared";
import type { NextRequest } from "next/server";
import { z } from "zod";

/**
 * Zod schema for role grant/revoke request validation
 *
 * Uses the canonical ADMIN_ROLES and ADMIN_PERMISSIONS constants from @feed/db
 * to ensure validation stays in sync with the database schema.
 */
const RoleRequestSchema = z.object({
  userId: z.string().min(1, "userId is required"),
  action: z.enum(["grant", "revoke"]),
  role: z.enum(ADMIN_ROLES).optional(),
  permissions: z.array(z.enum(ADMIN_PERMISSIONS)).optional(),
});

/**
 * Custom error class for role operations that need to be caught
 * and converted to proper API responses
 */
class RoleOperationError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = "RoleOperationError";
  }
}

export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const admins = await getAllAdmins();

  return successResponse({
    admins: admins.map((admin) => ({
      userId: admin.userId,
      username: admin.username,
      displayName: admin.displayName,
      profileImageUrl: admin.profileImageUrl,
      role: admin.role,
      permissions: admin.permissions,
      grantedAt: toISO(admin.grantedAt),
      grantedBy: admin.grantedBy,
    })),
    total: admins.length,
  });
});

export const POST = withErrorHandling(async (request: NextRequest) => {
  const admin = await requireSuperAdmin(request);

  // Rate limit role management to prevent abuse
  const rateLimitResult = applyRateLimit(
    admin.userId,
    RATE_LIMIT_CONFIGS.ADMIN_ACTION,
  );
  if (!rateLimitResult.allowed) {
    return rateLimitError(rateLimitResult.retryAfter);
  }

  const body = await request.json();

  // Validate request body with Zod
  const parseResult = RoleRequestSchema.safeParse(body);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    return errorResponse(
      firstIssue?.message ?? "Invalid request body",
      "VALIDATION_ERROR",
      400,
    );
  }

  // Extract validated data with proper typing
  const { userId, action, role, permissions } = parseResult.data as {
    userId: string;
    action: "grant" | "revoke";
    role?: AdminRoleType;
    permissions?: AdminPermission[];
  };

  const [targetUser] = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!targetUser) {
    return errorResponse("User not found", "USER_NOT_FOUND", 404);
  }

  if (action === "grant") {
    if (!role) {
      return errorResponse(
        `Valid role is required. Must be one of: ${ADMIN_ROLES.join(", ")}`,
        "INVALID_ROLE",
        400,
      );
    }

    // Get default permissions for the role
    const roleDefaultPermissions = ROLE_PERMISSIONS[role];

    // If custom permissions provided, validate they are a subset of role's allowed permissions
    if (permissions) {
      const invalidPermissions = permissions.filter(
        (p) => !roleDefaultPermissions.includes(p),
      );
      if (invalidPermissions.length > 0) {
        return errorResponse(
          `Custom permissions must be a subset of ${role} permissions. Invalid: ${invalidPermissions.join(", ")}`,
          "INVALID_PERMISSIONS",
          400,
        );
      }
    }

    const finalPermissions: AdminPermission[] =
      permissions ?? roleDefaultPermissions;
    const now = new Date();

    // Use transaction to ensure atomic role grant + isAdmin flag update
    await db.transaction(async (tx) => {
      // Use upsert (onConflictDoUpdate) to prevent race conditions
      await tx
        .insert(adminRoles)
        .values({
          id: `admin_role_${generateSnowflakeId()}`,
          userId,
          role,
          permissions: finalPermissions,
          grantedBy: admin.userId,
          grantedAt: now,
        })
        .onConflictDoUpdate({
          target: adminRoles.userId,
          set: {
            role,
            permissions: finalPermissions,
            grantedBy: admin.userId,
            grantedAt: now,
            revokedAt: null,
          },
        });

      // Update legacy isAdmin flag for backward compatibility (atomic with role grant)
      await tx.update(users).set({ isAdmin: true }).where(eq(users.id, userId));
    });

    logger.info(
      "Admin role granted/updated",
      { targetUserId: userId, role, grantedBy: admin.userId },
      "POST /api/admin/roles",
    );

    return successResponse({
      success: true,
      message: `${role} role granted to user`,
      user: {
        userId,
        username: targetUser.username,
        displayName: targetUser.displayName,
        role,
        permissions: finalPermissions,
      },
    });
  }

  // Only check for active (non-revoked) roles
  const [existingRole] = await db
    .select()
    .from(adminRoles)
    .where(and(eq(adminRoles.userId, userId), isNull(adminRoles.revokedAt)))
    .limit(1);

  if (!existingRole) {
    return errorResponse(
      "User does not have an active admin role",
      "NO_ACTIVE_ROLE",
      400,
    );
  }

  if (admin.userId === userId) {
    return errorResponse(
      "Cannot revoke your own admin role",
      "CANNOT_REVOKE_SELF",
      400,
    );
  }

  // Use transaction with SELECT FOR UPDATE to prevent race condition
  // when revoking super admin - locks the rows during the check and revoke
  try {
    await db.transaction(async (tx) => {
      // Check if this would remove the last super admin
      if (existingRole.role === "SUPER_ADMIN") {
        // Use SELECT FOR UPDATE to acquire row locks and prevent concurrent revocations
        const superAdminCountResult = await tx.execute(
          sql`SELECT COUNT(*) as count FROM ${adminRoles}
              WHERE ${adminRoles.role} = 'SUPER_ADMIN'
              AND ${adminRoles.revokedAt} IS NULL
              FOR UPDATE`,
        );

        const superAdminCountValue = Number(
          (superAdminCountResult[0] as { count: string })?.count ?? 0,
        );
        if (superAdminCountValue <= 1) {
          throw new RoleOperationError(
            "Cannot revoke the last super admin",
            "LAST_SUPER_ADMIN",
            400,
          );
        }
      }

      await tx
        .update(adminRoles)
        .set({ revokedAt: new Date() })
        .where(eq(adminRoles.userId, userId));

      await tx
        .update(users)
        .set({ isAdmin: false })
        .where(eq(users.id, userId));
    });
  } catch (error) {
    if (error instanceof RoleOperationError) {
      return errorResponse(error.message, error.code, error.statusCode);
    }
    throw error; // Re-throw unexpected errors to be handled by withErrorHandling
  }

  logger.info(
    "Admin role revoked",
    { targetUserId: userId, revokedBy: admin.userId },
    "POST /api/admin/roles",
  );

  return successResponse({
    success: true,
    message: "Admin role revoked",
    user: {
      userId,
      username: targetUser.username,
      displayName: targetUser.displayName,
    },
  });
});
