/**
 * Admin Agent Toggle API
 *
 * @route POST /api/admin/agents/[agentId]/toggle - Toggle agent autonomous mode
 * @access Admin
 *
 * @description
 * Enables or disables all autonomous features for an agent (trading, posting,
 * commenting, DMs, group chats). Updates agent status accordingly.
 * Requires admin authentication.
 *
 * @openapi
 * /api/admin/agents/{agentId}/toggle:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Toggle agent autonomous mode
 *     description: Enables or disables all autonomous features for an agent (admin only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *         description: Agent user ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - enabled
 *             properties:
 *               enabled:
 *                 type: boolean
 *                 description: Enable or disable autonomous mode
 *     responses:
 *       200:
 *         description: Agent toggled successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Agent not found
 *
 * @example
 * ```typescript
 * await fetch(`/api/admin/agents/${agentId}/toggle`, {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${adminToken}` },
 *   body: JSON.stringify({ enabled: true })
 * });
 * ```
 *
 * @see {@link /lib/api/admin-middleware} Admin middleware
 */

import {
  getClientIp,
  logAdminModify,
  requireAdmin,
  withErrorHandling,
} from '@babylon/api';
import { db, eq, userAgentConfigs } from '@babylon/db';
import { logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const POST = withErrorHandling(
  async (
    req: NextRequest,
    context: { params: Promise<{ agentId: string }> }
  ) => {
    const admin = await requireAdmin(req);
    const { agentId } = await context.params;
    const body = await req.json();
    const { enabled } = body;

    // Audit log the admin action
    logAdminModify({
      adminId: admin.userId,
      ipAddress: getClientIp(req.headers) ?? undefined,
      resourceType: 'agent',
      resourceId: agentId,
      metadata: { action: 'toggle_autonomous_mode', enabled },
    });

    // Toggle all autonomous features in agent config
    await db
      .update(userAgentConfigs)
      .set({
        autonomousTrading: enabled,
        autonomousPosting: enabled,
        autonomousCommenting: enabled,
        autonomousDMs: enabled,
        autonomousGroupChats: enabled,
        status: enabled ? 'running' : 'paused',
        updatedAt: new Date(),
      })
      .where(eq(userAgentConfigs.userId, agentId));

    logger.info(
      `Agent ${agentId} autonomous mode ${enabled ? 'enabled' : 'disabled'}`,
      undefined,
      'AdminAgentsAPI'
    );

    return NextResponse.json({
      success: true,
      message: `Agent ${enabled ? 'enabled' : 'paused'} successfully`,
    });
  }
);
