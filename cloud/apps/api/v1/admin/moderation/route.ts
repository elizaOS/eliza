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

import { Hono } from "hono";
import { z } from "zod";
import { ApiError, ValidationError } from "@/lib/api/cloud-worker-errors";
import { requireAdmin, requireUserOrApiKey } from "@/lib/auth/workers-hono-auth";
import { adminService } from "@/lib/services/admin";
import type {
  AdminModerationActionResponse,
  AdminModerationAdminsResponse,
  AdminModerationCombinedResponse,
  AdminModerationOverviewResponse,
  AdminModerationUserDetailResponse,
  AdminModerationUserStatusDto,
  AdminModerationUsersResponse,
  AdminModerationView,
  AdminModerationViolationDto,
  AdminModerationViolationsResponse,
  AdminUserDto,
} from "@/lib/types/cloud-api";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const ViewSchema = z.enum(["overview", "violations", "users", "admins", "user-detail"]);
const CombinableViews = ["overview", "violations", "users", "admins"] as const;
type CombinableView = (typeof CombinableViews)[number];

function isCombinableView(value: string): value is CombinableView {
  return (CombinableViews as readonly string[]).includes(value);
}
const LimitSchema = z.coerce.number().int().min(1).max(1000).default(100);
const AdminRoleSchema = z.enum(["super_admin", "moderator", "viewer"]);

type AdminUserRecord = Awaited<ReturnType<typeof adminService.listAdmins>>[number];
type ModerationViolationRecord = Awaited<
  ReturnType<typeof adminService.getRecentViolations>
>[number];
type ModerationStatusRecord = Awaited<
  ReturnType<typeof adminService.getUsersFlaggedForReview>
>[number];
type UserDetails = Awaited<ReturnType<typeof adminService.getUserDetails>>;

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoStringOrNull(value: Date | string | null): string | null {
  return value ? toIsoString(value) : null;
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function toAdminRole(role: string | null): z.infer<typeof AdminRoleSchema> | null {
  if (role === null) return null;
  const parsed = AdminRoleSchema.safeParse(role);
  if (!parsed.success) {
    throw new ApiError(500, "internal_error", "Admin role is invalid");
  }
  return parsed.data;
}

function toViolationDto(
  violation: ModerationViolationRecord,
  messageTextMaxLength: number,
): AdminModerationViolationDto {
  return {
    id: violation.id,
    userId: violation.userId,
    roomId: violation.roomId,
    messageText: truncateText(violation.messageText, messageTextMaxLength),
    categories: violation.categories,
    scores: violation.scores,
    action: violation.action,
    reviewedBy: violation.reviewedBy,
    reviewedAt: toIsoStringOrNull(violation.reviewedAt),
    reviewNotes: violation.reviewNotes,
    createdAt: toIsoString(violation.createdAt),
  };
}

function toModerationStatusDto(status: ModerationStatusRecord): AdminModerationUserStatusDto {
  return {
    id: status.id,
    userId: status.userId,
    status: status.status,
    totalViolations: status.totalViolations,
    warningCount: status.warningCount,
    riskScore: status.riskScore,
    bannedBy: status.bannedBy,
    bannedAt: toIsoStringOrNull(status.bannedAt),
    banReason: status.banReason,
    lastViolationAt: toIsoStringOrNull(status.lastViolationAt),
    lastWarningAt: toIsoStringOrNull(status.lastWarningAt),
    createdAt: toIsoString(status.createdAt),
    updatedAt: toIsoString(status.updatedAt),
  };
}

function toAdminUserDto(admin: AdminUserRecord): AdminUserDto {
  return {
    id: admin.id,
    userId: admin.userId,
    walletAddress: admin.walletAddress,
    role: admin.role,
    isActive: admin.isActive,
    grantedBy: admin.grantedBy,
    grantedByWallet: admin.grantedByWallet,
    notes: admin.notes,
    createdAt: toIsoString(admin.createdAt),
    updatedAt: toIsoString(admin.updatedAt),
    revokedAt: toIsoStringOrNull(admin.revokedAt),
  };
}

function toUserDetailResponse(details: UserDetails): AdminModerationUserDetailResponse {
  return {
    user: details.user
      ? {
          id: details.user.id,
          email: details.user.email,
          wallet_address: details.user.wallet_address,
          name: details.user.name,
          created_at: toIsoString(details.user.created_at),
        }
      : null,
    moderationStatus: details.moderationStatus
      ? toModerationStatusDto(details.moderationStatus)
      : null,
    violations: details.violations.map((violation) => toViolationDto(violation, 500)),
    generationsCount: details.generationsCount,
  };
}

async function buildOverview(
  walletAddress: string | null,
  role: string | null,
): Promise<AdminModerationOverviewResponse> {
  const [violations, flaggedUsers, bannedUsers, admins] = await Promise.all([
    adminService.getRecentViolations(10),
    adminService.getUsersFlaggedForReview(),
    adminService.getBannedUsers(),
    adminService.listAdmins(),
  ]);

  return {
    recentViolations: violations.map((violation) => toViolationDto(violation, 100)),
    totalViolations: violations.length,
    flaggedUsers: flaggedUsers.length,
    bannedUsers: bannedUsers.length,
    adminCount: admins.length,
    currentAdmin: {
      wallet: walletAddress,
      role: toAdminRole(role),
    },
  };
}

async function buildViolations(limit: number): Promise<AdminModerationViolationsResponse> {
  const violations = await adminService.getRecentViolations(limit);
  return {
    violations: violations.map((violation) => toViolationDto(violation, 200)),
    total: violations.length,
  };
}

async function buildUsers(): Promise<AdminModerationUsersResponse> {
  const [flaggedUsers, bannedUsers] = await Promise.all([
    adminService.getUsersFlaggedForReview(),
    adminService.getBannedUsers(),
  ]);
  return {
    flaggedUsers: flaggedUsers.map(toModerationStatusDto),
    bannedUsers: bannedUsers.map(toModerationStatusDto),
    totalFlagged: flaggedUsers.length,
    totalBanned: bannedUsers.length,
  };
}

async function buildAdmins(role: string | null): Promise<AdminModerationAdminsResponse> {
  const admins = await adminService.listAdmins();
  return {
    admins: admins.map(toAdminUserDto),
    total: admins.length,
    canManageAdmins: role === "super_admin",
  };
}

async function adminStatusResponse(c: AppContext): Promise<Response> {
  const notAdminResponse = () => {
    c.header("X-Is-Admin", "false");
    c.header("X-Admin-Role", "");
    return c.body(null, 200);
  };

  try {
    const user = await requireUserOrApiKey(c);

    const { isAdmin, role } = await adminService.getAdminStatusForUser(user);

    c.header("X-Is-Admin", String(isAdmin));
    c.header("X-Admin-Role", role ?? "");
    return c.body(null, 200);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      return notAdminResponse();
    }
    throw error;
  }
}

/**
 * HEAD /api/v1/admin/moderation
 * Quick check if current user is an admin.
 * Returns 200 with X-Is-Admin header for status checks (not 403 for non-admins).
 * Infrastructure errors are allowed to propagate to the global JSON error handler.
 */
app.on("HEAD", "/", async (c) => {
  return adminStatusResponse(c);
});

/**
 * GET /api/v1/admin/moderation
 * Get admin dashboard data.
 *
 * Query params:
 * - view: single view ("overview" | "violations" | "users" | "admins" |
 *   "user-detail") OR a comma-separated combination of the four
 *   non-detail views (e.g. "overview,admins,users,violations"). When more
 *   than one view is requested the response is an
 *   `AdminModerationCombinedResponse` keyed by view name; with a single
 *   value the response shape matches the per-view DTO for backward
 *   compatibility.
 * - limit: Number of items to return (default 100, applied to violations).
 * - userId: For user-detail view.
 */
app.get("/", async (c) => {
  if (c.req.method === "HEAD") {
    return adminStatusResponse(c);
  }

  const { user, role } = await requireAdmin(c);

  const rawView = c.req.query("view") ?? "overview";

  const parsedLimit = LimitSchema.safeParse(c.req.query("limit"));
  if (!parsedLimit.success) {
    throw ValidationError("limit must be an integer from 1 to 1000");
  }
  const limit = parsedLimit.data;
  const userId = c.req.query("userId");

  // Multi-view path: comma-separated list of combinable views. user-detail is
  // intentionally excluded because it requires a userId and returns a
  // fundamentally different shape.
  if (rawView.includes(",")) {
    const requested = rawView
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

    const seen = new Set<CombinableView>();
    for (const v of requested) {
      if (!isCombinableView(v)) {
        throw ValidationError(
          `Invalid view "${v}" in multi-view request. Combinable views: ${CombinableViews.join(", ")}`,
        );
      }
      seen.add(v);
    }

    const wantOverview = seen.has("overview");
    const wantViolations = seen.has("violations");
    const wantUsers = seen.has("users");
    const wantAdmins = seen.has("admins");

    const [overview, violations, users, admins] = await Promise.all([
      wantOverview ? buildOverview(user.wallet_address ?? null, role) : Promise.resolve(undefined),
      wantViolations ? buildViolations(limit) : Promise.resolve(undefined),
      wantUsers ? buildUsers() : Promise.resolve(undefined),
      wantAdmins ? buildAdmins(role) : Promise.resolve(undefined),
    ]);

    const response: AdminModerationCombinedResponse = {};
    if (overview) response.overview = overview;
    if (violations) response.violations = violations;
    if (users) response.users = users;
    if (admins) response.admins = admins;

    return c.json(response);
  }

  const parsedView = ViewSchema.safeParse(rawView);
  if (!parsedView.success) {
    throw ValidationError(
      "Invalid view. Must be: overview, violations, users, admins, user-detail",
    );
  }

  const view: AdminModerationView = parsedView.data;

  switch (view) {
    case "overview":
      return c.json(await buildOverview(user.wallet_address ?? null, role));

    case "violations":
      return c.json(await buildViolations(limit));

    case "users":
      return c.json(await buildUsers());

    case "admins":
      return c.json(await buildAdmins(role));

    case "user-detail": {
      if (!userId) throw ValidationError("userId required for user-detail view");
      const details = await adminService.getUserDetails(userId);
      return c.json(toUserDetailResponse(details));
    }

    default:
      throw ValidationError(
        "Invalid view. Must be: overview, violations, users, admins, user-detail",
      );
  }
});

const ActionSchema = z.object({
  action: z.enum([
    "ban",
    "unban",
    "mark_spammer",
    "mark_scammer",
    "clear_status",
    "clear_flags",
    "add_admin",
    "revoke_admin",
  ]),
  userId: z.string().min(1).optional(),
  targetUserId: z.string().min(1).optional(),
  walletAddress: z.string().optional(),
  targetWalletAddress: z.string().optional(),
  role: z.enum(["super_admin", "moderator", "viewer"]).default("moderator"),
  reason: z.string().optional(),
  notes: z.string().optional(),
});

function actionResponse(
  message: string,
  admin?: AdminModerationActionResponse["admin"],
): AdminModerationActionResponse {
  return admin ? { success: true, message, admin } : { success: true, message };
}

/**
 * POST /api/v1/admin/moderation
 * Perform admin actions.
 */
app.post("/", async (c) => {
  const { user, role: adminRole } = await requireAdmin(c);

  const body = await c.req.json().catch(() => {
    throw ValidationError("Invalid JSON");
  });

  const parsed = ActionSchema.safeParse(body);
  if (!parsed.success) {
    throw ValidationError("Invalid request", { issues: parsed.error.issues });
  }

  const action = parsed.data.action === "clear_flags" ? "clear_status" : parsed.data.action;
  const userId = parsed.data.userId ?? parsed.data.targetUserId;
  const walletAddress = parsed.data.walletAddress ?? parsed.data.targetWalletAddress;
  const { role, reason, notes } = parsed.data;

  if ((action === "add_admin" || action === "revoke_admin") && adminRole !== "super_admin") {
    throw new ApiError(403, "access_denied", "Only super_admin can manage other admins");
  }

  logger.info("[Admin] Action", {
    action,
    adminUserId: user.id,
    adminWallet: user.wallet_address,
    targetUserId: userId,
    targetWallet: walletAddress,
  });

  switch (action) {
    case "ban": {
      if (!userId) throw ValidationError("userId required");
      await adminService.banUser({
        userId,
        adminUserId: user.id,
        reason: reason ?? "",
      });
      return c.json(actionResponse("User banned"));
    }

    case "unban": {
      if (!userId) throw ValidationError("userId required");
      await adminService.unbanUser(userId, user.id);
      return c.json(actionResponse("User unbanned"));
    }

    case "mark_spammer": {
      if (!userId) throw ValidationError("userId required");
      await adminService.markUserAs({
        userId,
        status: "spammer",
        adminUserId: user.id,
        reason,
      });
      return c.json(actionResponse("User marked as spammer"));
    }

    case "mark_scammer": {
      if (!userId) throw ValidationError("userId required");
      await adminService.markUserAs({
        userId,
        status: "scammer",
        adminUserId: user.id,
        reason,
      });
      return c.json(actionResponse("User marked as scammer"));
    }

    case "clear_status": {
      if (!userId) throw ValidationError("userId required");
      await adminService.unbanUser(userId, user.id);
      return c.json(actionResponse("User status cleared"));
    }

    case "add_admin": {
      if (!walletAddress) throw ValidationError("walletAddress required");
      const admin = await adminService.promoteToAdmin({
        walletAddress,
        role,
        grantedByWallet: user.wallet_address ?? undefined,
        notes,
      });
      return c.json(
        actionResponse("Admin added", {
          id: admin.id,
          walletAddress: admin.walletAddress,
          role: admin.role,
        }),
      );
    }

    case "revoke_admin": {
      if (!walletAddress) throw ValidationError("walletAddress required");

      if (walletAddress.toLowerCase() === user.wallet_address?.toLowerCase()) {
        throw ValidationError("Cannot revoke your own admin privileges");
      }

      await adminService.revokeAdmin(walletAddress, user.wallet_address ?? undefined);
      return c.json(actionResponse("Admin privileges revoked"));
    }

    default:
      throw ValidationError("Unknown action");
  }
});

export default app;
