/**
 * Admin Training Rollback API
 *
 * @route POST /api/admin/training/rollback - Rollback model version
 * @access Admin
 *
 * @description
 * Rollback endpoint for trained models.
 * Currently disabled until the agent runtime consumes deployed-model records
 * for inference selection.
 *
 * @openapi
 * /api/admin/training/rollback:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Rollback endpoint (currently disabled)
 *     description: Returns 503 until runtime model routing is wired to deployed model records
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - targetVersion
 *             properties:
 *               targetVersion:
 *                 type: string
 *                 description: Model version to rollback to
 *     responses:
 *       200:
 *         description: Reserved for future rollback support
 *       400:
 *         description: Target version required
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       503:
 *         description: Rollback is currently disabled
 *
 * @example
 * ```typescript
 * await fetch('/api/admin/training/rollback', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${adminToken}` },
 *   body: JSON.stringify({ targetVersion: 'v0.9.0' })
 * });
 * ```
 */

import {
  BadRequestError,
  requireAdmin,
  ServiceUnavailableError,
  withErrorHandling,
} from '@feed/api';
import type { NextRequest } from 'next/server';

export const POST = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const body = await request.json();
  const { targetVersion } = body;

  if (!targetVersion) {
    throw new BadRequestError('Target version required');
  }

  throw new ServiceUnavailableError(
    `Trained model rollback is disabled. Requested rollback target ${targetVersion}, but agent runtime model selection is not wired to deployed model records yet.`
  );
});
