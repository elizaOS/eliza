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

export const transferAction: Action = {
  name: 'WALLET_TRANSFER',
  similes: ['SEND_TOKENS', 'TRANSFER_FUNDS', 'PAY', 'SEND_SOL', 'SEND_ETH', 'SEND_USDC'],
  description:
    'Transfer SOL, ETH, USDC, or any ERC-20/SPL token to another address. ' +
    'Works on both EVM chains (Base, Arbitrum, Optimism) and Solana. ' +
    'Spend limit is enforced automatically.',

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
      const text = "I don't have a wallet configured yet.";
      callback?.({ text });
      return { success: false, text };
    }

    const params = parseTransferIntent(message.content.text ?? '');
    if (!params) {
      const text = 'Could not parse transfer details. Please specify: to address, amount, and token.';
      callback?.({ text });
      return { success: false, text };
    }

    try {
      const result = await sdk.transfer(params);
      const text = `Sent ${params.amount} ${params.token} to ${params.toAddress}. Tx: ${result.txHash}`;
      callback?.({
        text,
        content: { success: true, txHash: result.txHash, params },
      });
      return { success: true, text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const text = `Transfer failed: ${msg}`;
      callback?.({ text });
      return { success: false, text, error: msg };
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Send 0.1 SOL to 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Sent 0.1 SOL to 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU. Tx: abc123...',
          action: 'WALLET_TRANSFER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Transfer 50 USDC to 0x742d35Cc6634C0532925a3b8D4C9C6Fb93' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Sent 50 USDC to 0x742d35Cc6634C0532925a3b8D4C9C6Fb93. Tx: 0xabc...',
          action: 'WALLET_TRANSFER',
        },
      },
    ],
  ],
};

// ── Simple NLP parser ─────────────────────────────────────────────────────────
function parseTransferIntent(text: string) {
  const match = text.match(
    /(?:send|transfer|pay)\s+([\d.]+)\s+(\w+)\s+to\s+([\w.]+)/i
  );
  if (!match) return null;
  return { amount: match[1], token: match[2].toUpperCase(), toAddress: match[3] };
}
