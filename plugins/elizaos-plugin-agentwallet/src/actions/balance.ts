import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
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
  ): Promise<ActionResult> => {
    const sdk = await getSDK(runtime);
    if (!sdk) {
      callback?.({ text: 'No wallet configured.' });
      return { success: false, text: 'No wallet configured.' };
    }

    try {
      const balances = await sdk.getBalances();
      const lines = balances.map(
        (b: TokenBalance) =>
          `${b.symbol}: ${b.balance}${b.usdValue !== undefined && b.usdValue !== null ? ` (~$${b.usdValue.toFixed(2)})` : ''}`
      );

      callback?.({
        text: lines.length
          ? `Wallet balances on ${sdk.getNetwork()}:\n${lines.join('\n')}`
          : 'Wallet is empty.',
      });
      return {
        success: true,
        data: {
          address: sdk.getAddress(),
          balances: balances.map((b: TokenBalance) => ({
            symbol: b.symbol,
            balance: String(b.balance),
            usdValue: b.usdValue ?? null,
          })),
        },
      };
    } catch (err) {
      const msg = `Failed to fetch balances: ${(err as Error).message}`;
      callback?.({ text: msg });
      return { success: false, text: msg, error: err as Error };
    }
  },

  examples: [
    [
      { name: '{{user1}}', content: { text: 'What is my wallet balance?' } },
      {
        name: '{{agentName}}',
        content: {
          text: 'Wallet balances on base:\nETH: 0.5 (~$1200.00)\nUSDC: 250.00 (~$250.00)',
          actions: ['WALLET_BALANCE'],
        },
      },
    ],
  ],
};
