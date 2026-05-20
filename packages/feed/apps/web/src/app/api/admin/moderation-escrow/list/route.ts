/**
 * Admin Moderation Escrow List API
 *
 * @route GET /api/admin/moderation-escrow/list - List escrow payments
 * @access Admin
 *
 * @description
 * Returns list of moderation escrow payments with filtering by recipient,
 * admin, or status. Supports pagination.
 *
 * @openapi
 * /api/admin/moderation-escrow/list:
 *   get:
 *     tags:
 *       - Admin
 *     summary: List moderation escrow payments
 *     description: Returns escrow payments with filtering and pagination (admin only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: recipientId
 *         schema:
 *           type: string
 *         description: Filter by recipient ID
 *       - in: query
 *         name: adminId
 *         schema:
 *           type: string
 *         description: Filter by admin ID
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, paid, refunded, expired]
 *         description: Filter by payment status
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Results per page
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *         description: Pagination offset
 *     responses:
 *       200:
 *         description: Payments retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 payments:
 *                   type: array
 *                 total:
 *                   type: integer
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *
 * @example
 * ```typescript
 * const { payments } = await fetch('/api/admin/moderation-escrow/list?status=pending', {
 *   headers: { 'Authorization': `Bearer ${adminToken}` }
 * }).then(r => r.json());
 * ```
 */

import { requireAdmin, withErrorHandling } from "@feed/api";
import { and, db, desc, eq, lt, moderationEscrows, sql } from "@feed/db";
import { toISO, toISOOrNull } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

const ListEscrowQuerySchema = z.object({
  recipientId: z.string().optional(),
  adminId: z.string().optional(),
  status: z.enum(["pending", "paid", "refunded", "expired"]).optional(),
  limit: z.coerce.number().min(1).max(100).optional().default(50),
  offset: z.coerce.number().min(0).optional().default(0),
});

export const GET = withErrorHandling(async (req: NextRequest) => {
  await requireAdmin(req);

  const { searchParams } = new URL(req.url);
  const validation = ListEscrowQuerySchema.safeParse({
    recipientId: searchParams.get("recipientId"),
    adminId: searchParams.get("adminId"),
    status: searchParams.get("status"),
    limit: searchParams.get("limit"),
    offset: searchParams.get("offset"),
  });

  if (!validation.success) {
    return NextResponse.json(
      {
        error:
          validation.error.issues[0]?.message || "Invalid query parameters",
      },
      { status: 400 },
    );
  }

  const { recipientId, adminId, status, limit, offset } = validation.data;

  // Auto-expire old pending escrows before querying
  // NOTE: This is a side-effect in a read endpoint for convenience.
  // It ensures expired escrows are marked correctly when admins view the list.
  // The update is idempotent (only affects pending escrows past their expiresAt)
  // and uses a single atomic UPDATE, so concurrent requests are safe.
  // For high-traffic production, consider moving this to a cron job instead.
  const now = new Date();
  await db
    .update(moderationEscrows)
    .set({ status: "expired" })
    .where(
      and(
        eq(moderationEscrows.status, "pending"),
        lt(moderationEscrows.expiresAt, now),
      ),
    );

  // Build where conditions for SQL query
  const whereConditions: ReturnType<typeof eq>[] = [];
  if (recipientId)
    whereConditions.push(eq(moderationEscrows.recipientId, recipientId));
  if (adminId) whereConditions.push(eq(moderationEscrows.adminId, adminId));
  if (status) whereConditions.push(eq(moderationEscrows.status, status));
  const whereClause =
    whereConditions.length > 0 ? and(...whereConditions) : undefined;

  // Use aliases for the multiple user joins
  const recipientAlias = sql`"recipient"`;
  const adminAlias = sql`"admin"`;
  const refunderAlias = sql`"refunder"`;

  // Query with multiple LEFT JOINs to get user data
  const escrowsQuery = await db
    .select({
      id: moderationEscrows.id,
      recipientId: moderationEscrows.recipientId,
      adminId: moderationEscrows.adminId,
      amountUSD: moderationEscrows.amountUSD,
      amountWei: moderationEscrows.amountWei,
      status: moderationEscrows.status,
      reason: moderationEscrows.reason,
      paymentRequestId: moderationEscrows.paymentRequestId,
      paymentTxHash: moderationEscrows.paymentTxHash,
      refundTxHash: moderationEscrows.refundTxHash,
      refundedBy: moderationEscrows.refundedBy,
      refundedAt: moderationEscrows.refundedAt,
      createdAt: moderationEscrows.createdAt,
      expiresAt: moderationEscrows.expiresAt,
      // Recipient user data
      recipientUsername: sql<string | null>`${recipientAlias}."username"`,
      recipientDisplayName: sql<string | null>`${recipientAlias}."displayName"`,
      recipientProfileImageUrl: sql<
        string | null
      >`${recipientAlias}."profileImageUrl"`,
      // Admin user data
      adminUsername: sql<string | null>`${adminAlias}."username"`,
      adminDisplayName: sql<string | null>`${adminAlias}."displayName"`,
      // Refunder user data
      refunderUsername: sql<string | null>`${refunderAlias}."username"`,
      refunderDisplayName: sql<string | null>`${refunderAlias}."displayName"`,
    })
    .from(moderationEscrows)
    .leftJoin(
      sql`"User" AS ${recipientAlias}`,
      sql`${moderationEscrows.recipientId} = ${recipientAlias}."id"`,
    )
    .leftJoin(
      sql`"User" AS ${adminAlias}`,
      sql`${moderationEscrows.adminId} = ${adminAlias}."id"`,
    )
    .leftJoin(
      sql`"User" AS ${refunderAlias}`,
      sql`${moderationEscrows.refundedBy} = ${refunderAlias}."id"`,
    )
    .where(whereClause)
    .orderBy(desc(moderationEscrows.createdAt))
    .limit(limit)
    .offset(offset);

  // Get total count for pagination
  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(moderationEscrows)
    .where(whereClause);
  const total = countResult?.count ?? 0;

  return NextResponse.json({
    success: true,
    escrows: escrowsQuery.map((escrow) => ({
      id: escrow.id,
      recipientId: escrow.recipientId,
      recipient: {
        id: escrow.recipientId,
        username: escrow.recipientUsername,
        displayName: escrow.recipientDisplayName,
        profileImageUrl: escrow.recipientProfileImageUrl,
      },
      adminId: escrow.adminId,
      admin: {
        id: escrow.adminId,
        username: escrow.adminUsername,
        displayName: escrow.adminDisplayName,
      },
      amountUSD: escrow.amountUSD,
      amountWei: escrow.amountWei,
      status: escrow.status,
      reason: escrow.reason,
      paymentRequestId: escrow.paymentRequestId,
      paymentTxHash: escrow.paymentTxHash,
      refundTxHash: escrow.refundTxHash,
      refundedBy: escrow.refundedBy,
      refundedByUser: escrow.refundedBy
        ? {
            id: escrow.refundedBy,
            username: escrow.refunderUsername,
            displayName: escrow.refunderDisplayName,
          }
        : null,
      refundedAt: toISOOrNull(escrow.refundedAt),
      createdAt: toISO(escrow.createdAt),
      expiresAt: toISO(escrow.expiresAt),
    })),
    pagination: {
      total,
      limit,
      offset,
    },
  });
});
