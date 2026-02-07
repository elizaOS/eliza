/**
 * Admin Moderation API
 *
 * Comprehensive endpoints for admin panel:
 * - View/manage admins
 * - View/manage users
 * - View moderation violations
 * - Ban/unban users
 * - Mark users as spammers/scammers
 *
 * Authentication: Requires wallet-connected user with admin privileges.
 * In devnet, the default anvil wallet (0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266) is auto-admin.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { adminService } from "@/lib/services/admin";
import { logger } from "@/lib/utils/logger";
import { z } from "zod";

/**
 * Middleware to check admin access
 * Optimized: Uses single cached getAdminStatus() call instead of separate isAdmin + getAdminRole.
 */
async function requireAdmin(request: NextRequest) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  if (!user.wallet_address) {
    return {
      error: "Wallet connection required for admin access",
      status: 401,
      user: null,
      isAdmin: false,
      role: null,
    };
  }

  // Single cached call instead of two separate DB queries
  const { isAdmin, role } = await adminService.getAdminStatus(
    user.wallet_address,
  );

  if (!isAdmin) {
    return {
      error: "Admin access required",
      status: 403,
      user,
      isAdmin: false,
      role: null,
    };
  }

  return {
    error: null,
    status: 200,
    user,
    isAdmin: true,
    role,
  };
}

/**
 * GET /api/v1/admin/moderation
 * Get admin dashboard data.
 *
 * Query params:
 * - view: "overview" | "violations" | "users" | "admins" | "user-detail"
 * - limit: Number of items to return (default 100)
 * - userId: For user-detail view
 */
export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const url = new URL(request.url);
  const view = url.searchParams.get("view") || "overview";
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") || "100"),
    1000,
  );
  const userId = url.searchParams.get("userId");

  switch (view) {
    case "overview": {
      const [violations, flaggedUsers, bannedUsers, admins] = await Promise.all(
        [
          adminService.getRecentViolations(10),
          adminService.getUsersFlaggedForReview(),
          adminService.getBannedUsers(),
          adminService.listAdmins(),
        ],
      );

      return NextResponse.json({
        recentViolations: violations.map((v) => ({
          ...v,
          messageText: v.messageText.slice(0, 100) + "...",
        })),
        totalViolations: violations.length,
        flaggedUsers: flaggedUsers.length,
        bannedUsers: bannedUsers.length,
        adminCount: admins.length,
        currentAdmin: {
          wallet: auth.user?.wallet_address,
          role: auth.role,
        },
      });
    }

    case "violations": {
      const violations = await adminService.getRecentViolations(limit);
      return NextResponse.json({
        violations: violations.map((v) => ({
          ...v,
          messageText:
            v.messageText.slice(0, 200) +
            (v.messageText.length > 200 ? "..." : ""),
        })),
        total: violations.length,
      });
    }

    case "users": {
      const flaggedUsers = await adminService.getUsersFlaggedForReview();
      const bannedUsers = await adminService.getBannedUsers();

      return NextResponse.json({
        flaggedUsers,
        bannedUsers,
        totalFlagged: flaggedUsers.length,
        totalBanned: bannedUsers.length,
      });
    }

    case "admins": {
      const admins = await adminService.listAdmins();
      return NextResponse.json({
        admins,
        total: admins.length,
        canManageAdmins: auth.role === "super_admin",
      });
    }

    case "user-detail": {
      if (!userId) {
        return NextResponse.json(
          { error: "userId required for user-detail view" },
          { status: 400 },
        );
      }

      const details = await adminService.getUserDetails(userId);
      return NextResponse.json(details);
    }

    default:
      return NextResponse.json(
        {
          error:
            "Invalid view. Must be: overview, violations, users, admins, user-detail",
        },
        { status: 400 },
      );
  }
}

const ActionSchema = z.object({
  action: z.enum([
    "ban",
    "unban",
    "mark_spammer",
    "mark_scammer",
    "clear_status",
    "add_admin",
    "revoke_admin",
  ]),
  userId: z.string().uuid().optional(),
  walletAddress: z.string().optional(),
  role: z.enum(["super_admin", "moderator", "viewer"]).default("moderator"),
  reason: z.string().optional(),
  notes: z.string().optional(),
});

/**
 * POST /api/v1/admin/moderation
 * Perform admin actions.
 *
 * Body:
 * - action: The action to perform
 * - userId: User ID (for user actions)
 * - walletAddress: Wallet address (for admin actions)
 * - role: Admin role (for add_admin)
 * - reason: Reason for the action
 * - notes: Additional notes
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const body = await request.json();
  const parsed = ActionSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.format() },
      { status: 400 },
    );
  }

  const { action, userId, walletAddress, role, reason, notes } = parsed.data;

  // Check permissions for admin management
  if (
    (action === "add_admin" || action === "revoke_admin") &&
    auth.role !== "super_admin"
  ) {
    return NextResponse.json(
      { error: "Only super_admin can manage other admins" },
      { status: 403 },
    );
  }

  logger.info("[Admin] Action", {
    action,
    adminUserId: auth.user?.id,
    adminWallet: auth.user?.wallet_address,
    targetUserId: userId,
    targetWallet: walletAddress,
  });

  switch (action) {
    case "ban": {
      if (!userId) {
        return NextResponse.json({ error: "userId required" }, { status: 400 });
      }
      if (!reason) {
        return NextResponse.json(
          { error: "reason required for ban" },
          { status: 400 },
        );
      }
      await adminService.banUser({
        userId,
        adminUserId: auth.user!.id,
        reason,
      });
      return NextResponse.json({ success: true, message: "User banned" });
    }

    case "unban": {
      if (!userId) {
        return NextResponse.json({ error: "userId required" }, { status: 400 });
      }
      await adminService.unbanUser(userId, auth.user!.id);
      return NextResponse.json({ success: true, message: "User unbanned" });
    }

    case "mark_spammer": {
      if (!userId) {
        return NextResponse.json({ error: "userId required" }, { status: 400 });
      }
      await adminService.markUserAs({
        userId,
        status: "spammer",
        adminUserId: auth.user!.id,
        reason,
      });
      return NextResponse.json({
        success: true,
        message: "User marked as spammer",
      });
    }

    case "mark_scammer": {
      if (!userId) {
        return NextResponse.json({ error: "userId required" }, { status: 400 });
      }
      await adminService.markUserAs({
        userId,
        status: "scammer",
        adminUserId: auth.user!.id,
        reason,
      });
      return NextResponse.json({
        success: true,
        message: "User marked as scammer",
      });
    }

    case "clear_status": {
      if (!userId) {
        return NextResponse.json({ error: "userId required" }, { status: 400 });
      }
      await adminService.unbanUser(userId, auth.user!.id);
      return NextResponse.json({
        success: true,
        message: "User status cleared",
      });
    }

    case "add_admin": {
      if (!walletAddress) {
        return NextResponse.json(
          { error: "walletAddress required" },
          { status: 400 },
        );
      }
      const admin = await adminService.promoteToAdmin({
        walletAddress,
        role,
        grantedByWallet: auth.user?.wallet_address,
        notes,
      });
      return NextResponse.json({
        success: true,
        message: "Admin added",
        admin: {
          id: admin.id,
          walletAddress: admin.walletAddress,
          role: admin.role,
        },
      });
    }

    case "revoke_admin": {
      if (!walletAddress) {
        return NextResponse.json(
          { error: "walletAddress required" },
          { status: 400 },
        );
      }

      // Can't revoke yourself
      if (
        walletAddress.toLowerCase() === auth.user?.wallet_address?.toLowerCase()
      ) {
        return NextResponse.json(
          { error: "Cannot revoke your own admin privileges" },
          { status: 400 },
        );
      }

      await adminService.revokeAdmin(walletAddress, auth.user?.wallet_address);
      return NextResponse.json({
        success: true,
        message: "Admin privileges revoked",
      });
    }

    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}

/**
 * HEAD /api/v1/admin/moderation
 * Quick check if current user is an admin.
 * Returns 200 with X-Is-Admin header for status checks (not 403 for non-admins).
 *
 * Optimized: Uses single cached getAdminStatus() call instead of separate isAdmin + getAdminRole.
 */
export async function HEAD(request: NextRequest) {
  // Helper to return not-admin response
  const notAdminResponse = () =>
    new NextResponse(null, {
      status: 200,
      headers: {
        "X-Is-Admin": "false",
        "X-Admin-Role": "",
      },
    });

  try {
    // Use the less restrictive auth that doesn't require organization
    // This allows checking admin status for users without full accounts
    const { requireAuthOrApiKey } = await import("@/lib/auth");
    let user;

    try {
      const result = await requireAuthOrApiKey(request);
      user = result.user;
    } catch {
      // Not authenticated - return not-admin
      return notAdminResponse();
    }

    if (!user?.wallet_address) {
      return notAdminResponse();
    }

    // Single cached call instead of two separate DB queries
    const { isAdmin, role } = await adminService.getAdminStatus(
      user.wallet_address,
    );

    return new NextResponse(null, {
      status: 200,
      headers: {
        "X-Is-Admin": String(isAdmin),
        "X-Admin-Role": role || "",
      },
    });
  } catch {
    // Any other error - return not-admin status
    return notAdminResponse();
  }
}
