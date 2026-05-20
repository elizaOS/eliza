/**
 * Admin Training Model Selection API
 *
 * @route GET /api/admin/training/model-selection - Get model selection info
 * @access Admin
 *
 * @description
 * Returns information about model selection for training including summary
 * and recommended base model selection.
 *
 * @openapi
 * /api/admin/training/model-selection:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get model selection information
 *     description: Returns model selection summary and recommendations (admin only)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Selection information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 summary:
 *                   type: object
 *                 selection:
 *                   type: object
 *                   nullable: true
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *
 * @example
 * ```typescript
 * const info = await fetch('/api/admin/training/model-selection', {
 *   headers: { 'Authorization': `Bearer ${adminToken}` }
 * }).then(r => r.json());
 * ```
 */

import { requireAdmin, successResponse, withErrorHandling } from "@feed/api";
import { modelSelectionService } from "@feed/training";
import type { NextRequest } from "next/server";

export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  // Get summary
  const summary = await modelSelectionService.getSelectionSummary();

  // Try to select base model
  let selection = null;
  const selectionError = null;

  selection = await modelSelectionService.selectBaseModel();

  return successResponse({
    success: true,
    summary,
    selection,
    selectionError,
  });
});
