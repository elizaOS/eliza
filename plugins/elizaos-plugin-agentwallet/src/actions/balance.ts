import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';
import type { TokenBalance } from '../types';
import { getSDK } from '../providers/wallet';

export const balanceAction: Action = {
  name: 'WALLET_BALANCE',
  similes: ['CHECK_BALANCE', 'GET_BALANCE', 'WALLET_STATUS', 'HOW_MUCH_DO_I_HAVE'],
  description:
    'Check the current token balances in the agent wallet. ' +
    'Returns all token balances with USD estimates.',

  validate: async (runtime: IAgentRuntime, _message: Memory): Promise<boolean> => {
    return !!(
      runtime.getSetting('AGENTWALLET_PRIVATE_KEY') ||
      runtime.getSetting('AGENTWALLET_SOLANA_PRIVATE_KEY')
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    const sdk = await getSDK(runtime);
    if (!sdk) {
      callback?.({ text: 'No wallet configured.' });
      return false;
    }

    try {
      const balances = await sdk.getBalances();
      const lines = balances.map(
        (b: TokenBalance) =>
          `${b.symbol}: ${b.balance}${b.usdValue != null ? ` (~$${b.usdValue.toFixed(2)})` : ''}`
      );

      callback?.({
        text: lines.length
          ? `Wallet balances on ${sdk.getNetwork()}:\n${lines.join('\n')}`
          : 'Wallet is empty.',
        content: { balances, address: sdk.getAddress() },
      });
      return true;
    } catch (err) {
      callback?.({ text: `Failed to fetch balances: ${(err as Error).message}` });
      return false;
    }
  },

  examples: [
    [
      { user: '{{user1}}', content: { text: 'What is my wallet balance?' } },
      {
        user: '{{agentName}}',
        content: {
          text: 'Wallet balances on base:\nETH: 0.5 (~$1200.00)\nUSDC: 250.00 (~$250.00)',
          action: 'WALLET_BALANCE',
        },
      },
    ],
  ],
};
