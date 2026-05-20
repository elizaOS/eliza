/**
 * Market Bias Configuration API
 *
 * @route POST /api/markets/bias/configure - Configure market biases
 * @access Authenticated
 *
 * @description
 * Configures market biases for entities (organizations, people, etc.). Supports
 * setting new biases, removing existing ones, or bulk-setting multiple biases.
 * Used to manipulate market sentiment and prices for game mechanics.
 *
 * @openapi
 * /api/markets/bias/configure:
 *   post:
 *     tags:
 *       - Markets
 *     summary: Configure market biases
 *     description: Sets, removes, or bulk-sets market biases for entities
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             oneOf:
 *               - type: object
 *                 required:
 *                   - action
 *                   - entityId
 *                   - entityName
 *                   - direction
 *                 properties:
 *                   action:
 *                     type: string
 *                     enum: [set]
 *                   entityId:
 *                     type: string
 *                   entityName:
 *                     type: string
 *                   direction:
 *                     type: string
 *                     enum: [up, down]
 *                   strength:
 *                     type: number
 *                     minimum: 0
 *                     maximum: 1
 *                   durationHours:
 *                     type: number
 *                   decayRate:
 *                     type: number
 *                     minimum: 0
 *                     maximum: 1
 *               - type: object
 *                 required:
 *                   - action
 *                   - entityId
 *                 properties:
 *                   action:
 *                     type: string
 *                     enum: [remove]
 *                   entityId:
 *                     type: string
 *               - type: object
 *                 required:
 *                   - action
 *                   - biases
 *                 properties:
 *                   action:
 *                     type: string
 *                     enum: [bulk-set]
 *                   biases:
 *                     type: array
 *                     items:
 *                       type: object
 *     responses:
 *       200:
 *         description: Bias configured successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid configuration
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * // Set bias
 * await fetch('/api/markets/bias/configure', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     action: 'set',
 *     entityId: 'org-id',
 *     entityName: 'Organization',
 *     direction: 'up',
 *     strength: 0.5
 *   })
 * });
 * ```
 *
 * @see {@link /lib/feedback/bias-engine} Bias engine
 */

import { requireAdmin, withErrorHandling } from '@babylon/api';
import { biasEngine } from '@babylon/engine';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const SetBiasSchema = z.object({
  action: z.literal('set'),
  entityId: z.string().min(1),
  entityName: z.string().min(1),
  direction: z.enum(['up', 'down']),
  strength: z.number().min(0).max(1).optional(),
  durationHours: z.number().optional(),
  decayRate: z.number().min(0).max(1).optional(),
});

const RemoveBiasSchema = z.object({
  action: z.literal('remove'),
  entityId: z.string().min(1),
});

const BulkSetBiasSchema = z.object({
  action: z.literal('bulk-set'),
  biases: z
    .array(
      z.object({
        entityId: z.string().min(1),
        entityName: z.string().min(1),
        direction: z.enum(['up', 'down']),
        strength: z.number().min(0).max(1).optional(),
        durationHours: z.number().optional(),
        decayRate: z.number().min(0).max(1).optional(),
      })
    )
    .min(1),
});

const BiasConfigSchema = z.discriminatedUnion('action', [
  SetBiasSchema,
  RemoveBiasSchema,
  BulkSetBiasSchema,
]);

export const POST = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const json = await request.json();
  const parsed = BiasConfigSchema.parse(json);

  const body = parsed;

  if (body.action === 'set') {
    biasEngine.setBias(
      body.entityId,
      body.entityName,
      body.direction,
      body.strength,
      {
        durationHours: body.durationHours,
        decayRate: body.decayRate,
      }
    );

    const adjustment = biasEngine.getBiasAdjustment(body.entityId);

    return NextResponse.json(
      {
        success: true,
        message: `Bias configured: ${body.direction} ${body.entityName}`,
        bias: {
          entityId: body.entityId,
          entityName: body.entityName,
          direction: body.direction,
          strength: body.strength ?? 0.5,
          adjustment,
        },
      },
      { status: 201 }
    );
  }
  if (body.action === 'remove') {
    biasEngine.removeBias(body.entityId);

    return NextResponse.json({
      success: true,
      message: `Bias removed for entity: ${body.entityId}`,
    });
  }
  biasEngine.setBulkBiases(body.biases);

  return NextResponse.json(
    {
      success: true,
      message: `${body.biases.length} biases configured`,
      count: body.biases.length,
    },
    { status: 201 }
  );
});
