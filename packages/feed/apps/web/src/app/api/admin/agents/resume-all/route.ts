/**
 * Admin Agents Resume All API
 *
 * @route POST /api/admin/agents/resume-all - Resume all agents
 * @access Admin
 *
 * @description
 * Resumes all autonomous agents that have sufficient balance. Re-enables all
 * autonomous behaviors (trading, posting, commenting, DMs, group chats).
 * Admin only.
 */

import {
  getClientIp,
  logAdminModify,
  requireAdmin,
  withErrorHandling,
} from "@feed/api";
import { db, eq, gte, inArray, sql, userAgentConfigs, users } from "@feed/db";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const POST = withErrorHandling(async (req: NextRequest) => {
  const admin = await requireAdmin(req);

  // Audit log the admin action
  logAdminModify({
    adminId: admin.userId,
    ipAddress: getClientIp(req.headers) ?? undefined,
    resourceType: "agents",
    metadata: { action: "resume_all" },
  });

  // Find agents with sufficient virtualBalance (>= 1)
  const eligibleAgents = await db
    .select({ userId: userAgentConfigs.userId })
    .from(userAgentConfigs)
    .innerJoin(users, eq(userAgentConfigs.userId, users.id))
    .where(gte(sql`CAST(${users.virtualBalance} AS NUMERIC)`, 1));

  const eligibleUserIds = eligibleAgents.map((a) => a.userId);

  if (eligibleUserIds.length === 0) {
    return NextResponse.json({
      success: true,
      message: "No agents with sufficient balance found",
      data: { resumed: 0 },
    });
  }

  // Resume all eligible agents
  await db
    .update(userAgentConfigs)
    .set({
      autonomousTrading: true,
      autonomousPosting: true,
      autonomousCommenting: true,
      status: "running",
      updatedAt: new Date(),
    })
    .where(inArray(userAgentConfigs.userId, eligibleUserIds));

  logger.info(
    `Resumed ${eligibleUserIds.length} autonomous agents with balance >= 1`,
    undefined,
    "AdminAgentsAPI",
  );

  return NextResponse.json({
    success: true,
    message: `Resumed ${eligibleUserIds.length} agents with sufficient balance`,
    data: {
      resumed: eligibleUserIds.length,
    },
  });
});
