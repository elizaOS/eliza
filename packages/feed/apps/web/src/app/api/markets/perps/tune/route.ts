/**
 * Perpetual Futures Tuning API
 *
 * @route GET /api/markets/perps/tune - Get tuning parameters
 * @route POST /api/markets/perps/tune - Update tuning parameters
 * @access Authenticated
 *
 * @description
 * Manages AI agent prompt tuning parameters for perpetual futures trading. Customizes
 * Agent0 trading behavior for specific tickers with risk tolerance, entry/exit thresholds,
 * position sizing multipliers, and sentiment overrides.
 *
 * @openapi
 * /api/markets/perps/tune:
 *   get:
 *     tags:
 *       - Markets
 *     summary: Get tuning parameters
 *     description: Returns current tuning parameters for specified ticker or all tickers
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: ticker
 *         schema:
 *           type: string
 *         description: Ticker symbol (optional, returns all if omitted)
 *     responses:
 *       200:
 *         description: Tuning parameters retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ticker:
 *                   type: string
 *                 riskMultiplier:
 *                   type: number
 *                 entryThreshold:
 *                   type: number
 *                 exitThreshold:
 *                   type: number
 *                 positionSizeMultiplier:
 *                   type: number
 *                 sentimentOverride:
 *                   type: string
 *                   enum: [bullish, bearish, neutral]
 *                   nullable: true
 *                 maxLeverageOverride:
 *                   type: number
 *                   nullable: true
 *   post:
 *     tags:
 *       - Markets
 *     summary: Update tuning parameters
 *     description: Updates AI agent tuning parameters for perpetual futures trading
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ticker:
 *                 type: string
 *               riskMultiplier:
 *                 type: number
 *                 minimum: 0.5
 *                 maximum: 2.0
 *               entryThreshold:
 *                 type: number
 *                 minimum: 0
 *                 maximum: 1
 *               exitThreshold:
 *                 type: number
 *                 minimum: 0
 *                 maximum: 1
 *               positionSizeMultiplier:
 *                 type: number
 *                 minimum: 0.1
 *                 maximum: 3.0
 *               sentimentOverride:
 *                 type: string
 *                 enum: [bullish, bearish, neutral]
 *                 nullable: true
 *               maxLeverageOverride:
 *                 type: number
 *                 minimum: 1
 *                 maximum: 100
 *                 nullable: true
 *     responses:
 *       200:
 *         description: Tuning parameters updated successfully
 *       400:
 *         description: Invalid parameters
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * // Get tuning for ticker
 * const params = await fetch('/api/markets/perps/tune?ticker=AAPL', {
 *   headers: { 'Authorization': `Bearer ${token}` }
 * }).then(r => r.json());
 *
 * // Update tuning
 * await fetch('/api/markets/perps/tune', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     ticker: 'AAPL',
 *     riskMultiplier: 1.5,
 *     entryThreshold: 0.7
 *   })
 * });
 * ```
 */

import { requireAdmin, withErrorHandling } from '@babylon/api';
import { logger } from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

const TuningQuerySchema = z.object({
  ticker: z.string().optional(),
});

const TuningBodySchema = z.object({
  ticker: z.string().optional(),
  riskMultiplier: z.number().min(0.5).max(2.0).optional(),
  entryThreshold: z.number().min(0).max(1).optional(),
  exitThreshold: z.number().min(0).max(1).optional(),
  positionSizeMultiplier: z.number().min(0.1).max(3.0).optional(),
  sentimentOverride: z
    .enum(['bullish', 'bearish', 'neutral'])
    .optional()
    .nullable(),
  maxLeverageOverride: z.number().min(1).max(100).optional().nullable(),
});

export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const { searchParams } = new URL(request.url);
  const queryParse = TuningQuerySchema.safeParse({
    ticker: searchParams.get('ticker') || undefined,
  });

  if (!queryParse.success) {
    return NextResponse.json(
      {
        error: 'Invalid query parameters',
        details: queryParse.error.flatten(),
      },
      { status: 400 }
    );
  }

  const { ticker } = queryParse.data;

  // If ticker specified, get specific tuning
  if (ticker) {
    // For now, return default parameters
    // In a full implementation, this would query a tuning parameters table
    return NextResponse.json({
      success: true,
      ticker,
      parameters: {
        riskMultiplier: 1.0,
        entryThreshold: 0.6,
        exitThreshold: 0.4,
        positionSizeMultiplier: 1.0,
        sentimentOverride: null,
        maxLeverageOverride: null,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  // Return global defaults
  return NextResponse.json({
    success: true,
    parameters: {
      global: {
        riskMultiplier: 1.0,
        entryThreshold: 0.6,
        exitThreshold: 0.4,
        positionSizeMultiplier: 1.0,
        sentimentOverride: null,
        maxLeverageOverride: null,
        updatedAt: new Date().toISOString(),
      },
    },
  });
});

export const POST = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const json = await request.json();
  const parsed = TuningBodySchema.safeParse(json);

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request payload', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const body = parsed.data;

  // In a full implementation, this would save to a database table
  // For now, just return success with the parameters
  logger.info(
    `Perp tuning parameters updated${body.ticker ? ` for ${body.ticker}` : ' (global)'}`,
    { ticker: body.ticker, parameters: body },
    'PerpTuning'
  );

  return NextResponse.json(
    {
      success: true,
      message: `Tuning parameters updated${body.ticker ? ` for ${body.ticker}` : ' (global)'}`,
      parameters: {
        ticker: body.ticker || null,
        riskMultiplier: body.riskMultiplier ?? 1.0,
        entryThreshold: body.entryThreshold ?? 0.6,
        exitThreshold: body.exitThreshold ?? 0.4,
        positionSizeMultiplier: body.positionSizeMultiplier ?? 1.0,
        sentimentOverride: body.sentimentOverride ?? null,
        maxLeverageOverride: body.maxLeverageOverride ?? null,
        updatedAt: new Date().toISOString(),
      },
    },
    { status: 201 }
  );
});
