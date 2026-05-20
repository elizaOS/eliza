/**
 * Admin Training Models API
 *
 * @route GET /api/admin/training/models - Get trained models
 * @access Admin
 *
 * @description
 * Returns all trained model versions with metadata from database and blob storage.
 * Includes version, performance metrics, and deployment status.
 *
 * @openapi
 * /api/admin/training/models:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get trained models
 *     description: Returns all trained model versions with metadata (admin only)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Models retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 models:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       version:
 *                         type: string
 *                       performance:
 *                         type: object
 *                       deployed:
 *                         type: boolean
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *
 * @example
 * ```typescript
 * const { models } = await fetch('/api/admin/training/models', {
 *   headers: { 'Authorization': `Bearer ${adminToken}` }
 * }).then(r => r.json());
 * ```
 */

import { requireAdmin, successResponse, withErrorHandling } from "@feed/api";
import { db } from "@feed/db";
import { modelStorage } from "@feed/training";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);
  // Get models from database
  const dbModels = await db.trainedModel.findMany({
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  // Get models from Vercel Blob
  const blobModels = await modelStorage.listModels();

  // Merge data
  const models = dbModels.map((dbModel) => {
    const blobModel = blobModels.find((b) => b.version === dbModel.version);

    return {
      version: dbModel.version,
      baseModel: dbModel.baseModel,
      trainedAt: dbModel.createdAt,
      accuracy: dbModel.accuracy,
      avgReward: dbModel.avgReward,
      status: dbModel.status,
      agentsUsing: dbModel.agentsUsing,
      blobUrl: dbModel.storagePath,
      size: blobModel?.size || 0,
      wandbRunId: dbModel.wandbRunId,
    };
  });

  return successResponse({
    success: true,
    models,
    total: models.length,
  });
});
