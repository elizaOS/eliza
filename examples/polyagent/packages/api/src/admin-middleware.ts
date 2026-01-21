/**
 * Admin Authentication Middleware
 *
 * @description Middleware for verifying admin privileges. Authenticates the user
 * and checks if they have admin access. In development mode, supports dev admin
 * token authentication for easier testing. In production, requires full Privy
 * authentication and database admin flag verification.
 *
 * @security
 * - NEVER bypasses authentication based on localhost/host header
 * - Dev mode requires explicit dev admin token
 * - Production requires Privy auth + database admin flag
 *
 * @rbac
 * - SUPER_ADMIN: Full access, can manage other admins
 * - ADMIN: Can view all stats and perform admin actions
 * - VIEWER: Read-only access to admin dashboards
 */

import {
  type AdminPermission,
  type AdminRoleType,
  adminRoles,
  and,
  db,
  eq,
  isNull,
  notInArray,
  ROLE_PERMISSIONS,
  users,
} from "@polyagent/db";
import { checkForAdminEmail, logger } from "@polyagent/shared";
import type { NextRequest } from "next/server";
import type { AuthenticatedUser } from "./auth-middleware";
import { authenticate, getPrivyClient } from "./auth-middleware";
import { getDevAdminUser, isValidDevAdminToken } from "./dev-credentials";
import { AuthorizationError } from "./errors";

const isDevelopment = process.env.NODE_ENV !== "production";

/**
 * Authenticated admin user with role information
 */
export interface AuthenticatedAdminUser extends AuthenticatedUser {
  role: AdminRoleType | null;
  permissions: AdminPermission[];
}

/**
 * Get admin role and permissions for a user
 *
 * @param userId - The database user ID
 * @param privyId - Optional Privy ID for fetching verified email directly from Privy
 */
export async function getAdminRole(
  userId: string,
  privyId?: string,
): Promise<{ role: AdminRoleType | null; permissions: AdminPermission[] }> {
  // Check the adminRoles table first - only non-revoked roles
  const [adminRole] = await db
    .select({
      role: adminRoles.role,
      permissions: adminRoles.permissions,
    })
    .from(adminRoles)
    .where(and(eq(adminRoles.userId, userId), isNull(adminRoles.revokedAt)))
    .limit(1);

  if (adminRole?.role) {
    const role = adminRole.role as AdminRoleType;
    const permissions =
      (adminRole.permissions as AdminPermission[]) || ROLE_PERMISSIONS[role];
    return { role, permissions };
  }

  // Get user data for isAdmin check
  const [user] = await db
    .select({
      isAdmin: users.isAdmin,
      privyId: users.privyId,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  // Backward compatibility: Check isAdmin flag for legacy admins
  if (user?.isAdmin) {
    return { role: "SUPER_ADMIN", permissions: ROLE_PERMISSIONS.SUPER_ADMIN };
  }

  // Check admin email domain - fetch verified email directly from Privy for security
  // This ensures we're using Privy's verified email, not a potentially tampered database value
  // Check ALL linked emails, not just the primary one (handles users who linked admin email later)
  const adminDomain = process.env.ADMIN_EMAIL_DOMAIN?.trim();
  const effectivePrivyId = privyId ?? user?.privyId;

  if (adminDomain && effectivePrivyId) {
    const privyClient = getPrivyClient();
    const privyUser = await privyClient.getUser(effectivePrivyId);

    // Check all verified emails including linkedAccounts
    const { adminEmail, allVerifiedEmails } = checkForAdminEmail(privyUser);

    if (adminEmail) {
      logger.info(
        "Auto-promoting user to SUPER_ADMIN via verified Privy email domain",
        {
          userId,
          emailDomain: adminEmail.split("@")[1] ?? null,
          emailCount: allVerifiedEmails.length,
          privyId: effectivePrivyId,
        },
        "getAdminRole",
      );
      return { role: "SUPER_ADMIN", permissions: ROLE_PERMISSIONS.SUPER_ADMIN };
    }
  }

  return { role: null, permissions: [] };
}

/**
 * Authenticate request and verify admin privileges.
 *
 * In development mode:
 * - Accepts x-dev-admin-token header with valid dev token
 * - Falls back to standard Privy auth + admin check
 *
 * In production:
 * - Requires valid Privy authentication
 * - Requires isAdmin flag in database OR role in adminRoles table
 */
export async function requireAdmin(
  request: NextRequest,
): Promise<AuthenticatedAdminUser> {
  // In development, check for dev admin token first
  if (isDevelopment) {
    const devAdminToken = request.headers.get("x-dev-admin-token");
    if (devAdminToken && isValidDevAdminToken(devAdminToken)) {
      const devUser = getDevAdminUser();
      if (devUser) {
        logger.info(
          "Admin access granted via dev token",
          { userId: devUser.userId },
          "requireAdmin",
        );
        return {
          userId: devUser.userId,
          dbUserId: devUser.dbUserId,
          walletAddress: devUser.walletAddress,
          role: "SUPER_ADMIN",
          permissions: ROLE_PERMISSIONS.SUPER_ADMIN,
        };
      }
    }
  }

  // Standard authentication flow
  const user = await authenticate(request);

  // Check if user is banned
  const [dbUser] = await db
    .select({
      isAdmin: users.isAdmin,
      isBanned: users.isBanned,
      username: users.username,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.id, user.userId))
    .limit(1);

  if (!dbUser) {
    logger.warn(
      "Admin check failed: User not found in database",
      { userId: user.userId },
      "requireAdmin",
    );
    throw new AuthorizationError("User not found", "admin", "access");
  }

  if (dbUser.isBanned) {
    logger.warn(
      "Admin check failed: User is banned",
      { userId: user.userId },
      "requireAdmin",
    );
    throw new AuthorizationError("User is banned", "admin", "access");
  }

  // Get admin role (checks both adminRoles table, isAdmin flag, and Privy email domain)
  const { role, permissions } = await getAdminRole(user.userId, user.privyId);

  if (!role) {
    logger.warn(
      "Admin check failed: User is not an admin",
      {
        userId: user.userId,
        username: dbUser.username,
      },
      "requireAdmin",
    );
    throw new AuthorizationError("Admin access required", "admin", "access");
  }

  logger.info(
    "Admin access granted",
    {
      userId: user.userId,
      username: dbUser.username,
      role,
    },
    "requireAdmin",
  );

  return {
    ...user,
    role,
    permissions,
  };
}

/**
 * Require specific admin permission
 */
export async function requirePermission(
  request: NextRequest,
  permission: AdminPermission,
): Promise<AuthenticatedAdminUser> {
  const admin = await requireAdmin(request);

  if (!admin.permissions.includes(permission)) {
    logger.warn(
      "Permission check failed",
      {
        userId: admin.userId,
        role: admin.role,
        requiredPermission: permission,
      },
      "requirePermission",
    );
    throw new AuthorizationError(
      `Permission required: ${permission}`,
      "admin",
      permission,
    );
  }

  return admin;
}

/**
 * Require SUPER_ADMIN role
 */
export async function requireSuperAdmin(
  request: NextRequest,
): Promise<AuthenticatedAdminUser> {
  const admin = await requireAdmin(request);

  if (admin.role !== "SUPER_ADMIN") {
    logger.warn(
      "Super admin check failed",
      {
        userId: admin.userId,
        role: admin.role,
      },
      "requireSuperAdmin",
    );
    throw new AuthorizationError(
      "Super admin access required",
      "admin",
      "super_admin",
    );
  }

  return admin;
}

/**
 * Check if a user ID has admin privileges (without requiring request auth)
 */
export async function isUserAdmin(userId: string): Promise<boolean> {
  // getAdminRole already handles both adminRoles table and legacy isAdmin flag
  const { role } = await getAdminRole(userId);
  return role !== null;
}

/**
 * Get all admin users with their roles
 *
 * This function returns all admins from two sources:
 * 1. Users with active roles in the AdminRole table (non-revoked)
 * 2. Legacy admins (isAdmin = true) who haven't been migrated to AdminRole
 *
 * Performance: Uses SQL NOT IN to filter legacy admins at database level,
 * avoiding fetching all legacy admins and filtering in memory.
 */
export async function getAllAdmins(): Promise<
  Array<{
    userId: string;
    username: string | null;
    displayName: string | null;
    profileImageUrl: string | null;
    role: AdminRoleType;
    permissions: AdminPermission[];
    grantedAt: Date;
    grantedBy: string;
  }>
> {
  // Get users from adminRoles table (non-revoked)
  const roleAdmins = await db
    .select({
      userId: adminRoles.userId,
      role: adminRoles.role,
      permissions: adminRoles.permissions,
      grantedAt: adminRoles.grantedAt,
      grantedBy: adminRoles.grantedBy,
      username: users.username,
      displayName: users.displayName,
      profileImageUrl: users.profileImageUrl,
    })
    .from(adminRoles)
    .innerJoin(users, eq(adminRoles.userId, users.id))
    .where(isNull(adminRoles.revokedAt));

  // Extract user IDs for NOT IN clause
  const roleUserIds = roleAdmins.map((a) => a.userId);

  // Get legacy admins (isAdmin = true but NOT in adminRoles)
  // Use SQL NOT IN to filter at database level instead of in memory
  const legacyAdmins = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      profileImageUrl: users.profileImageUrl,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(
      roleUserIds.length > 0
        ? and(eq(users.isAdmin, true), notInArray(users.id, roleUserIds))
        : eq(users.isAdmin, true),
    );

  const results: Array<{
    userId: string;
    username: string | null;
    displayName: string | null;
    profileImageUrl: string | null;
    role: AdminRoleType;
    permissions: AdminPermission[];
    grantedAt: Date;
    grantedBy: string;
  }> = [];

  // Add role-based admins
  for (const admin of roleAdmins) {
    const role = admin.role as AdminRoleType;
    results.push({
      userId: admin.userId,
      username: admin.username,
      displayName: admin.displayName,
      profileImageUrl: admin.profileImageUrl,
      role,
      permissions:
        (admin.permissions as AdminPermission[]) || ROLE_PERMISSIONS[role],
      grantedAt: admin.grantedAt,
      grantedBy: admin.grantedBy,
    });
  }

  // Add legacy admins (already filtered by database - not in adminRoles)
  for (const legacy of legacyAdmins) {
    results.push({
      userId: legacy.id,
      username: legacy.username,
      displayName: legacy.displayName,
      profileImageUrl: legacy.profileImageUrl,
      role: "SUPER_ADMIN",
      permissions: ROLE_PERMISSIONS.SUPER_ADMIN,
      grantedAt: legacy.createdAt,
      grantedBy: legacy.id, // Self-granted for legacy
    });
  }

  return results;
}
