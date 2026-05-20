/**
 * Market Bias Tuning API
 *
 * @route POST /api/markets/bias/tune - Tune market bias
 * @access Authenticated
 *
 * @description
 * Adjusts strength of existing market biases without full reconfiguration.
 * Setting strength to 0 deactivates the bias. Allows fine-tuning of bias
 * parameters.
 *
 * @openapi
 * /api/markets/bias/tune:
 *   post:
 *     tags:
 *       - Markets
 *     summary: Tune market bias
 *     description: Adjusts strength of existing market bias (0 deactivates)
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - entityId
 *               - strength
 *             properties:
 *               entityId:
 *                 type: string
 *                 description: Entity ID to tune
 *               strength:
 *                 type: number
 *                 minimum: 0
 *                 maximum: 1
 *                 description: New strength (0 deactivates)
 *               decayRate:
 *                 type: number
 *                 minimum: 0
 *                 maximum: 1
 *                 description: Optional new decay rate
 *     responses:
 *       200:
 *         description: Bias tuned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 bias:
 *                   type: object
 *       400:
 *         description: Invalid parameters
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * await fetch('/api/markets/bias/tune', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     entityId: 'org-id',
 *     strength: 0.7
 *   })
 * });
 * ```
 *
 * @see {@link /lib/feedback/bias-engine} Bias engine
 */

import { requireAdmin, withErrorHandling } from "@feed/api";
import { biasEngine } from "@feed/engine";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

const TuneBiasSchema = z.object({
  entityId: z.string().min(1, "entityId is required"),
  strength: z.number().min(0).max(1),
  decayRate: z.number().min(0).max(1).optional(),
});

export const POST = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const json = await request.json();
  const parsed = TuneBiasSchema.parse(json);

  const body = parsed;

  if (body.strength === 0) {
    biasEngine.removeBias(body.entityId);

    logger.info(`Market bias deactivated for ${body.entityId}`, {
      entityId: body.entityId,
    });

    return NextResponse.json({
      success: true,
      message: `Bias deactivated for entity: ${body.entityId}`,
      bias: {
        entityId: body.entityId,
        strength: 0,
        active: false,
      },
    });
  }

  biasEngine.tuneBiasStrength(body.entityId, body.strength, body.decayRate);

  const updatedBias = biasEngine.getBiasAdjustment(body.entityId);

  logger.info(`Market bias tuned for ${body.entityId}`, {
    entityId: body.entityId,
    strength: body.strength,
    decayRate: body.decayRate,
  });

  return NextResponse.json({
    success: true,
    message: `Bias strength updated for entity: ${body.entityId}`,
    bias: {
      entityId: body.entityId,
      strength: body.strength,
      adjustment: updatedBias,
      decayRate: body.decayRate,
    },
  });
});
