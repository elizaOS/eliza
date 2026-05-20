/**
 * User Portfolio Breakdown API
 *
 * @route GET /api/users/[userId]/portfolio-breakdown
 * @access Public
 *
 * @description
 * Returns a canonical portfolio breakdown for consistent P/L across the app.
 * This includes wallet balance, agents-held balance, open positions value, and
 * a unified Total P/L computed as:
 *   (Agents + Positions + Wallet) - Original Amount (net deposits/withdrawals + transfers)
 */

import {
  BusinessLogicError,
  ensureMinimalUserByIdentifier,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import { calculatePortfolioBreakdown } from '@babylon/engine';
import { logger, UserIdParamSchema } from '@babylon/shared';
import type { NextRequest } from 'next/server';

export const GET = withErrorHandling(
  async (
    _request: NextRequest,
    context: { params: Promise<{ userId: string }> }
  ) => {
    const { userId } = UserIdParamSchema.parse(await context.params);
    const { id: canonicalUserId } = await ensureMinimalUserByIdentifier(userId);
    const snapshot = await calculatePortfolioBreakdown(canonicalUserId);

    if (!snapshot) {
      throw new BusinessLogicError(
        'User portfolio breakdown not found',
        'PORTFOLIO_BREAKDOWN_NOT_FOUND'
      );
    }

    logger.info(
      'Portfolio breakdown fetched successfully',
      { userId: canonicalUserId },
      'GET /api/users/[userId]/portfolio-breakdown'
    );

    return successResponse(snapshot);
  }
);
