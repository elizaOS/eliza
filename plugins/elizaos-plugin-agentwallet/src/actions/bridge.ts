import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';
import { getSDK } from '../providers/wallet';

export const bridgeAction: Action = {
  name: 'WALLET_BRIDGE',
  similes: ['BRIDGE_TOKENS', 'CROSS_CHAIN', 'CCTP_BRIDGE', 'BRIDGE_USDC'],
  description:
    "Bridge USDC cross-chain via Circle's CCTP V2. Supported routes include " +
    'Base, Arbitrum, Optimism, Ethereum, and Solana — any direction. ' +
    'Typical completion time: 2–5 minutes.',

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
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    const sdk = await getSDK(runtime);
    if (!sdk) {
      callback?.({ text: 'No wallet configured for bridging.' });
      return false;
    }

    const params = parseBridgeIntent(message.content.text ?? '');
    if (!params) {
      callback?.({
        text: 'Could not parse bridge details. Format: "bridge <amount> USDC from <chain> to <chain>"',
      });
      return false;
    }

    try {
      const result = await sdk.bridge(params);
      callback?.({
        text:
          `Bridging ${params.amount} USDC from ${params.fromChain} → ${params.toChain}. ` +
          `Tx: ${result.sourceTxHash}. ETA: ~3 min. Track: ${result.trackingUrl ?? 'check block explorer'}`,
        content: { success: true, ...result, params },
      });
      return true;
    } catch (err) {
      callback?.({ text: `Bridge failed: ${(err as Error).message}` });
      return false;
    }
  },

  examples: [
    [
      { user: '{{user1}}', content: { text: 'Bridge 100 USDC from base to solana' } },
      {
        user: '{{agentName}}',
        content: {
          text: 'Bridging 100 USDC from base → solana. Tx: 0xabc... ETA: ~3 min.',
          action: 'WALLET_BRIDGE',
        },
      },
    ],
    [
      { user: '{{user1}}', content: { text: 'bridge 500 USDC from arbitrum to optimism' } },
      {
        user: '{{agentName}}',
        content: {
          text: 'Bridging 500 USDC from arbitrum → optimism. Tx: 0xdef...',
          action: 'WALLET_BRIDGE',
        },
      },
    ],
  ],
};

function parseBridgeIntent(text: string) {
  const match = text.match(
    /bridge\s+([\d.]+)\s+(\w+)\s+from\s+(\w+(?:-\w+)?)\s+to\s+(\w+(?:-\w+)?)/i
  );
  if (!match) return null;
  return {
    amount: match[1],
    token: match[2].toUpperCase(),
    fromChain: match[3].toLowerCase(),
    toChain: match[4].toLowerCase(),
  };
}
