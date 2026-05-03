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
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const sdk = await getSDK(runtime);
    if (!sdk) {
      callback?.({ text: 'No wallet configured for bridging.' });
      return { success: false, text: 'No wallet configured for bridging.' };
    }

    const params = parseBridgeIntent(message.content.text ?? '');
    if (!params) {
      const text =
        'Could not parse bridge details. Format: "bridge <amount> USDC from <chain> to <chain>"';
      callback?.({ text });
      return { success: false, text };
    }

    try {
      const result = await sdk.bridge(params);
      const text =
        `Bridging ${params.amount} USDC from ${params.fromChain} → ${params.toChain}. ` +
        `Tx: ${result.sourceTxHash}. ETA: ~3 min. Track: ${result.trackingUrl ?? 'check block explorer'}`;
      callback?.({
        text,
        content: { success: true, ...result, params },
      });
      return { success: true, text };
    } catch (err) {
      const messageErr = err instanceof Error ? err.message : String(err);
      const text = `Bridge failed: ${messageErr}`;
      callback?.({ text });
      return { success: false, text, error: messageErr };
    }
  },

  examples: [
    [
      { name: '{{user1}}', content: { text: 'Bridge 100 USDC from base to solana' } },
      {
        name: '{{agentName}}',
        content: {
          text: 'Bridging 100 USDC from base → solana. Tx: 0xabc... ETA: ~3 min.',
          action: 'WALLET_BRIDGE',
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'bridge 500 USDC from arbitrum to optimism' } },
      {
        name: '{{agentName}}',
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
