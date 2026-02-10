import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from '@elizaos/core';
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
 * SIGNET_SPOTLIGHT_STATUS — Injects current Signet spotlight pricing and
 * availability into the agent's context so it can reason about advertising
 * opportunities without being explicitly asked.
 */
export const spotlightProvider: Provider = {
  name: 'SIGNET_SPOTLIGHT_STATUS',
  description:
    'Provides current Signet spotlight pricing and availability. ' +
    'Signet is an onchain advertising platform on Base where agents can buy spotlight ads with USDC via x402.',

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<ProviderResult> => {
    try {
      const config = getSignetConfig(runtime);
      const res = await fetch(
        `${config.baseUrl}/api/x402/estimate?guaranteeHours=0`,
        { signal: AbortSignal.timeout(5000) }
      );

      if (!res.ok) {
        return { text: 'Signet spotlight status: unavailable', values: {}, data: {} };
      }

      const data: EstimateResponse = await res.json();

      const availabilityText = data.spotlightAvailable
        ? 'available now'
        : `occupied for ${Math.ceil(data.spotlightRemainingSeconds / 60)}min`;

      return {
        text: `Signet spotlight: $${data.estimatedUSDC} USDC (0h guarantee), ${availabilityText}`,
        values: {
          signetPrice: data.estimatedUSDC,
          signetAvailable: String(data.spotlightAvailable),
        },
        data,
      };
    } catch (error) {
      logger.debug({ error }, 'Signet: failed to fetch spotlight status');
      return { text: 'Signet spotlight status: unreachable', values: {}, data: {} };
    }
  },
};
