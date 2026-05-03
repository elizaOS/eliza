import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { getSDK } from '../providers/wallet';

export const swapAction: Action = {
  name: 'WALLET_SWAP',
  similes: ['SWAP_TOKENS', 'EXCHANGE_TOKENS', 'TRADE_TOKENS', 'JUPITER_SWAP', 'UNISWAP'],
  description:
    'Swap tokens using Jupiter (Solana) or Uniswap V3 (EVM). ' +
    'The agent holds its own keys — no custodial intermediary. ' +
    'Slippage defaults to 0.5% but can be specified.',

  validate: async (runtime: IAgentRuntime, _message: Memory): Promise<boolean> => {
    return !!(
      runtime.getSetting('AGENTWALLET_PRIVATE_KEY') ||
      runtime.getSetting('AGENTWALLET_SOLANA_PRIVATE_KEY')
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const sdk = await getSDK(runtime);
    if (!sdk) {
      callback?.({ text: 'No wallet configured for swaps.' });
      return { success: false, text: 'No wallet configured for swaps.' };
    }

    const params = parseSwapIntent(message.content.text ?? '');
    if (!params) {
      const text = 'Could not parse swap details. Format: "swap <amount> <FROM> to <TO>"';
      callback?.({ text });
      return { success: false, text };
    }

    try {
      const result = await sdk.swap(params);
      const text = `Swapped ${params.amount} ${params.fromToken} → ${params.toToken}. Got: ${result.outputAmount}. Tx: ${result.txHash}`;
      callback?.({
        text,
        content: { success: true, ...result, params },
      });
      return { success: true, text };
    } catch (err) {
      const messageErr = err instanceof Error ? err.message : String(err);
      const text = `Swap failed: ${messageErr}`;
      callback?.({ text });
      return { success: false, text, error: messageErr };
    }
  },

  examples: [
    [
      { name: '{{user1}}', content: { text: 'Swap 0.5 SOL to USDC' } },
      {
        name: '{{agentName}}',
        content: {
          text: 'Swapped 0.5 SOL → USDC. Got: 48.32 USDC. Tx: abc...',
          action: 'WALLET_SWAP',
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'swap 100 USDC to ETH' } },
      {
        name: '{{agentName}}',
        content: {
          text: 'Swapped 100 USDC → ETH. Got: 0.0416 ETH. Tx: 0xabc...',
          action: 'WALLET_SWAP',
        },
      },
    ],
  ],
};

function parseSwapIntent(text: string) {
  const match = text.match(/swap\s+([\d.]+)\s+(\w+)\s+(?:to|for)\s+(\w+)/i);
  if (!match) return null;
  return { amount: match[1], fromToken: match[2].toUpperCase(), toToken: match[3].toUpperCase() };
}
