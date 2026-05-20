/**
 * Action Executor
 *
 * Executes decisions via Feed A2A protocol
 */

import type { JsonValue } from '@feed/shared';
import type { Decision } from './decision';

export interface ActionResult {
  success: boolean;
  message: string;
  data?: Record<string, JsonValue>;
  error?: string;
}

/**
 * Minimal interface for A2A client methods used by executeAction
 */
export interface A2AActionClient {
  buyShares(
    marketId: string,
    outcome: 'YES' | 'NO',
    amount: number
  ): Promise<Record<string, JsonValue>>;
  sellShares(
    positionId: string,
    shares: number
  ): Promise<Record<string, JsonValue>>;
  openPosition(
    ticker: string,
    side: 'LONG' | 'SHORT',
    amount: number,
    leverage: number
  ): Promise<Record<string, JsonValue>>;
  closePosition(positionId: string): Promise<Record<string, JsonValue>>;
  createPost(
    content: string,
    type?: string
  ): Promise<Record<string, JsonValue>>;
  createComment(
    postId: string,
    content: string
  ): Promise<Record<string, JsonValue>>;
}

/**
 * Execute agent decision via A2A
 */
export async function executeAction(
  client: A2AActionClient,
  decision: Decision
): Promise<ActionResult> {
  const params = decision.params || {};

  switch (decision.action) {
    case 'BUY_YES':
    case 'BUY_NO': {
      const marketId = params.marketId as string;
      const amount = params.amount as number;

      if (!marketId || typeof amount !== 'number') {
        return {
          success: false,
          message: 'Invalid parameters for buy shares',
          error: 'marketId and amount are required',
        };
      }

      const outcome = decision.action === 'BUY_YES' ? 'YES' : 'NO';
      const result = await client.buyShares(marketId, outcome, amount);

      return {
        success: true,
        message: `Bought ${outcome} shares in market ${marketId}`,
        data: result,
      };
    }

    case 'SELL': {
      const positionId = params.positionId as string;
      const shares = params.shares as number;

      if (!positionId || typeof shares !== 'number') {
        return {
          success: false,
          message: 'Invalid parameters for sell shares',
          error: 'positionId and shares are required',
        };
      }

      const result = await client.sellShares(positionId, shares);

      return {
        success: true,
        message: `Sold ${shares} shares`,
        data: result,
      };
    }

    case 'OPEN_LONG':
    case 'OPEN_SHORT': {
      const ticker = params.ticker as string;
      const size = params.size as number;
      const leverage = params.leverage as number;

      if (!ticker || typeof size !== 'number' || typeof leverage !== 'number') {
        return {
          success: false,
          message: 'Invalid parameters for open position',
          error: 'ticker, size, and leverage are required',
        };
      }

      const side = decision.action === 'OPEN_LONG' ? 'LONG' : 'SHORT';
      const result = await client.openPosition(ticker, side, size, leverage);

      return {
        success: true,
        message: `Opened ${side} position on ${ticker}`,
        data: result,
      };
    }

    case 'CLOSE_POSITION': {
      const positionId = params.positionId as string;

      if (!positionId) {
        return {
          success: false,
          message: 'Invalid parameters for close position',
          error: 'positionId is required',
        };
      }

      const result = await client.closePosition(positionId);

      return {
        success: true,
        message: `Closed position ${positionId}`,
        data: result,
      };
    }

    case 'CREATE_POST': {
      const content = params.content as string;

      if (!content || typeof content !== 'string') {
        return {
          success: false,
          message: 'Invalid parameters for create post',
          error: 'content is required',
        };
      }

      const result = await client.createPost(content, 'post');

      return {
        success: true,
        message: 'Created post',
        data: result,
      };
    }

    case 'CREATE_COMMENT': {
      const postId = params.postId as string;
      const content = params.content as string;

      if (!postId || !content || typeof content !== 'string') {
        return {
          success: false,
          message: 'Invalid parameters for create comment',
          error: 'postId and content are required',
        };
      }

      const result = await client.createComment(postId, content);

      return {
        success: true,
        message: `Created comment on ${postId}`,
        data: result,
      };
    }

    case 'HOLD':
    default:
      return {
        success: true,
        message: 'Holding - no action taken',
      };
  }
}
