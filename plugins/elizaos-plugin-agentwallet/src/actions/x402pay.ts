import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';
import { getSDK } from '../providers/wallet';

export const x402PayAction: Action = {
  name: 'X402_PAY',
  similes: ['PAY_API', 'MICROPAYMENT', 'PAY_ENDPOINT', 'X402_REQUEST'],
  description:
    'Pay for a resource or API endpoint using the x402 micropayment protocol. ' +
    'Works with any HTTP endpoint that returns a 402 Payment Required status. ' +
    'Sub-cent payments on EVM chains with automatic payment handling.',

  validate: async (runtime: IAgentRuntime, _message: Memory): Promise<boolean> => {
    return !!runtime.getSetting('AGENTWALLET_PRIVATE_KEY');
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
      callback?.({ text: 'No wallet configured for x402 payments.' });
      return false;
    }

    const params = parseX402Intent(message.content.text ?? '');
    if (!params) {
      callback?.({
        text: 'Please specify the endpoint URL and max payment amount. Example: "pay x402 endpoint https://api.example.com/data max 0.01 USDC"',
      });
      return false;
    }

    try {
      const result = await sdk.x402Pay(params);
      callback?.({
        text:
          `x402 payment sent — $${result.amountPaid} USDC to ${params.endpoint}. ` +
          `Response received: ${result.httpStatus} ${result.contentType ?? ''}`,
        content: { success: true, ...result, params },
      });
      return true;
    } catch (err) {
      callback?.({ text: `x402 payment failed: ${(err as Error).message}` });
      return false;
    }
  },

  examples: [
    [
      {
        user: '{{user1}}',
        content: { text: 'Pay x402 endpoint https://api.weatheragent.xyz/forecast max 0.001 USDC' },
      },
      {
        user: '{{agentName}}',
        content: {
          text: 'x402 payment sent — $0.001 USDC to https://api.weatheragent.xyz/forecast. Response: 200 application/json',
          action: 'X402_PAY',
        },
      },
    ],
  ],
};

function parseX402Intent(text: string) {
  const urlMatch = text.match(/https?:\/\/[^\s]+/);
  const amountMatch = text.match(/max\s+([\d.]+)/i);
  if (!urlMatch) return null;
  return {
    endpoint: urlMatch[0],
    maxAmountUsd: amountMatch ? amountMatch[1] : '0.01',
  };
}
