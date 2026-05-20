/**
 * Check Balance Action
 * Returns the agent's current wallet balance
 */

import { WalletService } from '@feed/engine';
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { logger } from '../../../../shared/logger';

export const checkBalanceAction: Action = {
  name: 'CHECK_BALANCE',
  description:
    'Check YOUR wallet balance. Use this before making trades to ensure you have sufficient funds.',
  parameters: [] as Action['parameters'],
  examples: [
    [
      {
        name: 'user',
        content: { text: 'What is your balance?' },
      },
      {
        name: 'assistant',
        content: { text: 'Let me check my current balance.' },
      },
    ],
    [
      {
        name: 'user',
        content: { text: 'How much money do you have?' },
      },
      {
        name: 'assistant',
        content: { text: "I'll check my wallet balance." },
      },
    ],
  ],

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State
  ): Promise<boolean> => true,

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const agentUserId = runtime.agentId;

    try {
      const balance = (await WalletService.getBalance(agentUserId)).balance;

      logger.info('[CHECK_BALANCE] Retrieved balance', {
        agentUserId,
        balance,
      });

      return {
        success: true,
        text: `Balance: $${balance.toFixed(2)}`,
        data: { balance, userId: agentUserId },
        values: { balance },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('[CHECK_BALANCE] Error:', errorMsg);
      return {
        success: false,
        text: `Failed to check balance: ${errorMsg}`,
        error: errorMsg,
      };
    }
  },
};
