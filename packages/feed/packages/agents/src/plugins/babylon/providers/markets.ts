/**
 * Markets Provider
 * Provides access to prediction markets and perpetual markets via A2A protocol
 *
 * A2A IS REQUIRED - This provider will not work without an active A2A connection
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from '@elizaos/core';
import { logger } from '../../../shared/logger';
import type { BabylonRuntime } from '../types';
// import type { A2APredictionsResponse, A2APerpetualsResponse } from '../../../types/a2a-responses' // Commented out - not needed

/**
 * Provider: Current Markets
 * Fetches available prediction markets and perp markets via A2A protocol
 */
export const marketsProvider: Provider = {
  name: 'BABYLON_MARKETS',
  description:
    'Get current available markets for trading (prediction markets and perpetual futures) via A2A protocol',

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    const babylonRuntime = runtime as BabylonRuntime;

    // A2A is REQUIRED
    if (!babylonRuntime.a2aClient?.isConnected()) {
      logger.error(
        'A2A client not connected - markets provider requires A2A protocol',
        undefined,
        runtime.agentId
      );
      return {
        text: 'ERROR: A2A client not connected. Cannot fetch markets data. Please ensure A2A server is running.',
      };
    }

    const [predictionsResult, perpetualsResult] = await Promise.all([
      babylonRuntime.a2aClient.getPredictions({ status: 'active' }),
      babylonRuntime.a2aClient.getPerpetuals(),
    ]);

    // Type assertion using A2A response types
    interface PredictionMarket {
      id: string;
      question: string;
      yesShares: number;
      noShares: number;
      liquidity: number;
      resolved: boolean;
      endDate: string | Date;
    }

    interface PerpetualMarket {
      name: string;
      type: string;
      currentPrice: number;
    }

    const predictionsData = predictionsResult as {
      predictions?: PredictionMarket[];
    };
    const perpetualsData = perpetualsResult as {
      perpetuals?: PerpetualMarket[];
    };

    const predictions = predictionsData.predictions || [];
    const perpetuals = perpetualsData.perpetuals || [];

    const predictionsText =
      predictions.length > 0
        ? `Prediction Markets:\n${predictions
            .slice(0, 10)
            .map(
              (m) =>
                `- ${m.question} (ID: ${m.id}) | YES: ${m.yesShares.toFixed(2)}, NO: ${m.noShares.toFixed(2)}, Liquidity: $${m.liquidity.toFixed(2)}`
            )
            .join('\n')}`
        : 'No active prediction markets available.';

    const perpetualsText =
      perpetuals.length > 0
        ? `Perpetual Markets:\n${perpetuals
            .slice(0, 10)
            .map(
              (p) =>
                `- ${p.name} (${p.type}) | Price: $${p.currentPrice.toFixed(2)}`
            )
            .join('\n')}`
        : 'No perpetual markets available.';

    return {
      text: `${predictionsText}\n\n${perpetualsText}`,
    };
  },
};
