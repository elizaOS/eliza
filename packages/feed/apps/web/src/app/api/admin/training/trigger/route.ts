/**
 * Admin Training Trigger API
 *
 * @route GET /api/admin/training/trigger - Get training readiness
 * @route POST /api/admin/training/trigger - Trigger training job
 * @access Admin
 *
 * @description
 * Manually triggers a training job or checks training readiness. GET returns
 * readiness status. POST triggers training with optional force flag and batch size.
 *
 * @openapi
 * /api/admin/training/trigger:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get training readiness
 *     description: Returns training readiness status (admin only)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Readiness status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *   post:
 *     tags:
 *       - Admin
 *     summary: Trigger training job
 *     description: Manually triggers a training job (admin only)
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               force:
 *                 type: boolean
 *                 default: false
 *               batchSize:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Training job triggered successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *
 * @example
 * ```typescript
 * await fetch('/api/admin/training/trigger', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${adminToken}` },
 *   body: JSON.stringify({ force: true })
 * });
 * ```
 */

import {
  getClientIp,
  logAdminModify,
  logAdminView,
  requireAdmin,
  withErrorHandling,
} from '@babylon/api';
import { automationPipeline } from '@babylon/training';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const POST = withErrorHandling(async (request: NextRequest) => {
  const admin = await requireAdmin(request);
  const body = await request.json();
  const { force = false, batchSize } = body;

  // Audit log the training trigger
  logAdminModify({
    adminId: admin.userId,
    ipAddress: getClientIp(request.headers) ?? undefined,
    resourceType: 'training',
    metadata: { action: 'trigger_training', force, batchSize },
  });

  const result = await automationPipeline.triggerTraining({
    force,
    batchSize,
  });

  return NextResponse.json(result);
});

export const GET = withErrorHandling(async (request: NextRequest) => {
  const admin = await requireAdmin(request);

  // Audit log the readiness check
  logAdminView({
    adminId: admin.userId,
    ipAddress: getClientIp(request.headers) ?? undefined,
    resourceType: 'training',
    metadata: { action: 'check_readiness' },
  });

  // Get training readiness
  const readiness = await automationPipeline.checkTrainingReadiness();
  return NextResponse.json(readiness);
});
