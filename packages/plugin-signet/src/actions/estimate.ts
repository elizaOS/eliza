import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { logger } from '@elizaos/core';
import { getSignetConfig } from '../config.ts';

/** Response shape from the Signet estimate API. */
interface EstimateResponse {
  guaranteeHours: number;
  estimatedUSDC: string;
  estimatedUSDCRaw: string;
  spotlightAvailable: boolean;
  spotlightRemainingSeconds: number;
}

/**
 * SIGNET_ESTIMATE — Check how much it costs to place a spotlight ad on Signet.
 *
 * Calls the public `/api/x402/estimate` endpoint (no wallet required).
 * Optionally extracts a guarantee duration from the user message.
 */
export const estimateSpotlightAction: Action = {
  name: 'SIGNET_ESTIMATE',
  similes: ['ESTIMATE_AD_COST', 'SIGNET_PRICE', 'SPOTLIGHT_COST', 'CHECK_AD_PRICE'],
  description:
    'Estimate the USDC cost to place an onchain spotlight ad on Signet (Base). ' +
    'Returns the price and whether the spotlight slot is currently available.',

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
    _responses?: Memory[]
  ): Promise<ActionResult> => {
    try {
      const config = getSignetConfig(runtime);
      const text = message.content.text || '';

      // Extract guarantee hours from natural language (e.g. "6 hour guarantee")
      const hoursMatch = text.match(/(\d+)\s*hour/i);
      const guaranteeHours = hoursMatch
        ? Math.min(Math.max(parseInt(hoursMatch[1], 10), 0), 24)
        : 0;

      const url = `${config.baseUrl}/api/x402/estimate?guaranteeHours=${guaranteeHours}`;
      logger.info({ url, guaranteeHours }, 'Signet: fetching estimate');

      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Signet API error ${res.status}: ${await res.text()}`);
      }

      const data: EstimateResponse = await res.json();

      const availabilityText = data.spotlightAvailable
        ? '✅ Available now'
        : `⏳ Occupied (${Math.ceil(data.spotlightRemainingSeconds / 60)}min remaining)`;

      const response = [
        '💰 **Signet Spotlight Estimate**',
        `• Cost: **$${data.estimatedUSDC} USDC**`,
        `• Guarantee: ${guaranteeHours}h`,
        `• Spotlight: ${availabilityText}`,
      ].join('\n');

      if (callback) {
        await callback({
          text: response,
          actions: ['SIGNET_ESTIMATE'],
          source: message.content.source,
        });
      }

      return { text: response, success: true, data };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, 'Signet: estimate failed');

      return {
        success: false,
        error: error instanceof Error ? error : new Error(msg),
      };
    }
  },

  examples: [
    [
      {
        name: '{{userName}}',
        content: { text: 'How much does a Signet spotlight ad cost?', actions: [] },
      },
      {
        name: '{{agentName}}',
        content: {
          text: '💰 **Signet Spotlight Estimate**\n• Cost: **$12.75 USDC**\n• Guarantee: 0h\n• Spotlight: ✅ Available now',
          actions: ['SIGNET_ESTIMATE'],
        },
      },
    ],
    [
      {
        name: '{{userName}}',
        content: { text: 'Estimate a 6 hour spotlight on Signet', actions: [] },
      },
      {
        name: '{{agentName}}',
        content: {
          text: '💰 **Signet Spotlight Estimate**\n• Cost: **$45.20 USDC**\n• Guarantee: 6h\n• Spotlight: ✅ Available now',
          actions: ['SIGNET_ESTIMATE'],
        },
      },
    ],
  ],
};
