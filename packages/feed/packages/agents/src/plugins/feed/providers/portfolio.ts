/**
 * Portfolio Provider
 * Provides access to agent's portfolio and positions via A2A protocol
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from '@elizaos/core';
import { logger } from '../../../shared/logger';
import type {
  A2ABalanceResponse,
  A2APositionsResponse,
} from '../../../types/a2a-responses';
import type { FeedRuntime } from '../types';

// Type guards for A2A responses
function isA2ABalanceResponse(data: object): data is A2ABalanceResponse {
  return (
    'balance' in data &&
    typeof (data as A2ABalanceResponse).balance === 'number'
  );
}

function isA2APositionsResponse(data: object): data is A2APositionsResponse {
  return (
    'marketPositions' in data &&
    Array.isArray((data as A2APositionsResponse).marketPositions)
  );
}

/**
 * Provider: Portfolio State
 * Gets agent's current positions and balance via A2A
 */
export const portfolioProvider: Provider = {
  name: 'FEED_PORTFOLIO',
  description:
    'Get agent portfolio state, positions, and balance via A2A protocol',

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    const feedRuntime = runtime as FeedRuntime;
    const agentUserId = runtime.agentId;

    // A2A is required
    if (!feedRuntime.a2aClient?.isConnected()) {
      logger.error(
        'A2A client not connected - portfolio provider requires A2A',
        undefined,
        runtime.agentId
      );
      return { text: 'A2A client not connected. Cannot fetch portfolio data.' };
    }

    const [balanceData, positionsData] = await Promise.all([
      feedRuntime.a2aClient.sendRequest('a2a.getBalance', {
        userId: agentUserId,
      }),
      feedRuntime.a2aClient.sendRequest('a2a.getPositions', {
        userId: agentUserId,
      }),
    ]);

    // Validate response structures using type guards
    if (
      !balanceData ||
      typeof balanceData !== 'object' ||
      !isA2ABalanceResponse(balanceData)
    ) {
      throw new Error('Invalid balance data format from A2A client');
    }
    if (
      !positionsData ||
      typeof positionsData !== 'object' ||
      !isA2APositionsResponse(positionsData)
    ) {
      throw new Error('Invalid positions data format from A2A client');
    }
    const balance = balanceData;
    const positions = positionsData;

    return {
      text: `Your Portfolio:

Balance: $${balance.balance || 0}
Points Balance: ${balance.reputationPoints || 0} pts

Open Prediction Positions (${positions.marketPositions?.length || 0}):
${positions.marketPositions?.map((p) => `- ${p.question}: ${p.side} ${p.shares} shares @ avg ${p.avgPrice}`).join('\n') || 'None'}

Open Perp Positions (${positions.perpPositions?.length || 0}):
${
  positions.perpPositions
    ?.map((p) => {
      const amount = p.amount || p.size;
      return `- ${p.ticker}: ${p.side.toUpperCase()} $${amount} @ ${p.entryPrice} (${p.leverage}x)
  Current: $${p.currentPrice}`;
    })
    .join('\n') || 'None'
}`,
    };
  },
};
