/**
 * User Wallet Provider
 * Allows agents to query ANY user's wallet balance and positions via A2A protocol
 * This is useful for analyzing other traders, following successful strategies, etc.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from '@elizaos/core';
import { logger } from '../../../shared/logger';
import type { A2AUserWalletResponse } from '../../../types/a2a-responses';
import type { FeedRuntime } from '../types';

// Type guard for A2A user wallet response
function isA2AUserWalletResponse(data: object): data is A2AUserWalletResponse {
  return 'balance' in data && 'positions' in data;
}

/**
 * Provider: Query User Wallet
 * Gets any user's wallet balance and positions via A2A protocol
 *
 * Usage in prompts: "Check user X's wallet" or "What positions does user Y have?"
 */
export const userWalletProvider: Provider = {
  name: 'FEED_USER_WALLET',
  description:
    "Query any user's wallet balance, points, and open positions via A2A protocol. Useful for analyzing other traders and following successful strategies.",

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    const feedRuntime = runtime as FeedRuntime;

    // A2A is REQUIRED
    if (!feedRuntime.a2aClient?.isConnected()) {
      logger.error(
        'A2A client not connected - user wallet provider requires A2A protocol',
        undefined,
        runtime.agentId
      );
      return {
        text: 'ERROR: A2A client not connected. Cannot query user wallets. Please ensure A2A server is running.',
      };
    }

    // Extract userId from message content
    // Look for patterns like "user_123", "@username", or explicit userId mentions
    const content = message.content?.text || '';
    let userId: string | null = null;

    // Try to extract user ID from common patterns
    const userIdMatch =
      content.match(/user[_\s]?(\w+)/i) ||
      content.match(/@(\w+)/) ||
      content.match(/userId[:\s]+(\w+)/i);

    if (userIdMatch) {
      userId = userIdMatch[1] || null;
    }

    // If no userId found in message, return error guidance
    if (!userId) {
      return {
        text: `To query a user's wallet, please specify the user ID or username in your message.
Example: "Check user_abc123's wallet" or "What positions does @trader have?"`,
      };
    }

    // Fetch wallet data via A2A protocol
    const walletData = await feedRuntime.a2aClient.sendRequest(
      'a2a.getUserWallet',
      { userId }
    );

    // Validate walletData structure using type guard
    if (
      !walletData ||
      typeof walletData !== 'object' ||
      !isA2AUserWalletResponse(walletData)
    ) {
      throw new Error('Invalid wallet data format from A2A client');
    }
    const walletTyped = walletData;

    const balance = walletTyped.balance;
    const positions = walletTyped.positions;

    const totalPositions =
      (positions.marketPositions?.length || 0) +
      (positions.perpPositions?.length || 0);
    const lifetimePnL = balance.lifetimePnL || 0;
    const isProfitable = lifetimePnL > 0;

    return {
      text: `User ${userId}'s Wallet:

💰 Balance: $${balance.balance || 0}
⭐ Points: ${balance.reputationPoints || 0} pts
${isProfitable ? '📈' : '📉'} Lifetime P&L: ${isProfitable ? '+' : ''}$${lifetimePnL}
💵 Total Deposited: $${balance.totalDeposited || 0}
💸 Total Withdrawn: $${balance.totalWithdrawn || 0}

📊 Open Positions (${totalPositions}):

${
  positions.perpPositions && positions.perpPositions.length > 0
    ? `🔮 Perpetual Futures (${positions.perpPositions.length}):
${positions.perpPositions
  .map((p) => {
    const amount = p.amount || p.size;
    return `  • ${p.ticker}: ${p.side.toUpperCase()} $${amount} @ ${p.entryPrice} (${p.leverage}x)
    Current: $${p.currentPrice} | P&L: ${p.unrealizedPnL >= 0 ? '+' : ''}$${p.unrealizedPnL}`;
  })
  .join('\n')}`
    : '🔮 No perpetual positions'
}

${
  positions.marketPositions && positions.marketPositions.length > 0
    ? `🎯 Prediction Markets (${positions.marketPositions.length}):
${positions.marketPositions
  .map(
    (p) => `  • ${p.side} on "${p.question.substring(0, 60)}..."
    ${p.shares.toFixed(2)} shares @ $${p.avgPrice.toFixed(3)} (Current: $${p.currentPrice.toFixed(3)})
    P&L: ${p.unrealizedPnL >= 0 ? '+' : ''}$${p.unrealizedPnL.toFixed(2)}`
  )
  .join('\n')}`
    : '🎯 No prediction market positions'
}

${
  isProfitable
    ? `This user appears to be a profitable trader with $${lifetimePnL} in gains.`
    : `This user has $${Math.abs(lifetimePnL)} in losses.`
}`,
    };
  },
};
