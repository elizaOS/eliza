/**
 * Admin Training Deploy Model API
 *
 * @route POST /api/admin/training/deploy - Deploy model version
 * @access Admin
 *
 * @description
 * Deployment intent endpoint for trained models.
 * Currently disabled until the agent runtime consumes deployed-model records
 * for inference selection.
 *
 * @openapi
 * /api/admin/training/deploy:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Deployment endpoint (currently disabled)
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
 *               - modelVersion
 *             properties:
 *               modelVersion:
 *                 type: string
 *               strategy:
 *                 type: string
 *                 enum: [gradual, immediate]
 *                 default: gradual
 *               rolloutPercentage:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 100
 *                 default: 10
 *     responses:
 *       200:
 *         description: Reserved for future deployment support
 *       400:
 *         description: Model version required
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       503:
 *         description: Deployment is currently disabled
 *
 * @example
 * ```typescript
 * await fetch('/api/admin/training/deploy', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${adminToken}` },
 *   body: JSON.stringify({ modelVersion: 'v1.0.0', strategy: 'gradual' })
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
  const { modelVersion, strategy = 'gradual', rolloutPercentage = 10 } = body;

  if (!modelVersion) {
    throw new BadRequestError('Model version required');
  }

  throw new ServiceUnavailableError(
    `Trained model deployment is disabled. Requested ${strategy} rollout (${rolloutPercentage}%) for ${modelVersion}, but agent runtime model selection is not wired to deployed model records yet.`
  );
});
