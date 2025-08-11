import type { Plugin } from '@elizaos/core';
import {
  type Action,
  type Content,
  type GenerateTextParams,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type Provider,
  type ProviderResult,
  Service,
  type State,
  logger,
} from '@elizaos/core';
import { z } from 'zod';
import { initializeQuickswapPluginAction } from './actions/initializeQuickswapPlugin.js';
import { fetchTokenDataAction } from './actions/fetchTokenData.js';
import { fetchPairDataAction } from './actions/fetchPairData.js';
import { swapTokensAction } from './actions/swapTokens.js';
import { addLiquidityAction } from './actions/addLiquidity.js';
import { removeLiquidityAction } from './actions/removeLiquidity.js';
import { getTransactionStatusAction } from './actions/getTransactionStatus.js';
import { calculateLiquidityValueAction } from './actions/calculateLiquidityValue.js';
import { calculateMidPriceAction } from './actions/calculateMidPrice.js';
import { calculateTokenPriceAction } from './actions/calculateTokenPrice.js';
import { executeLimitOrderStopLossTakeProfitAction } from './actions/executeLimitOrderStopLossTakeProfit.js';
import { supportFeeOnTransferTokensAction } from './actions/supportFeeOnTransferTokens.js';
import { calculatePriceImpactAction } from './actions/calculatePriceImpact.js';
import { getFarmingPoolDetailsAction } from './actions/getFarmingPoolDetails.js';
import { estimateGasFeesAction } from './actions/estimateGasFees.js';
import { claimFarmingRewardsAction } from './actions/claimFarmingRewards.js';

/**
 * Define the configuration schema for the Quickswap plugin
 */
const configSchema = z.object({
  QUICKSWAP_API_URL: z
    .string()
    .url('Quickswap API URL must be a valid URL')
    .optional()
    .default('https://api.quickswap.exchange')
    .transform((val) => {
      if (!val) {
        console.warn('Warning: QUICKSWAP_API_URL not provided, using default');
      }
      return val;
    }),
  WALLET_PRIVATE_KEY: z
    .string()
    .min(1, 'Wallet private key cannot be empty')
    .optional()
    .transform((val) => {
      if (!val) {
        console.warn('Warning: WALLET_PRIVATE_KEY not provided, trading features will be disabled');
      }
      return val;
    }),
});

/**
 * Quickswap Service for managing connections and state
 */
export class QuickswapService extends Service {
  static serviceType = 'quickswap';
  capabilityDescription =
    'This service provides access to Quickswap decentralized exchange on Polygon.';

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime) {
    logger.info('*** Starting Quickswap service ***');
    const service = new QuickswapService(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime) {
    logger.info('*** Stopping Quickswap service ***');
    const service = runtime.getService(QuickswapService.serviceType);
    if (!service) {
      throw new Error('Quickswap service not found');
    }
    service.stop();
  }

  async stop() {
    logger.info('*** Stopping Quickswap service instance ***');
  }
}

/**
 * Example provider for Quickswap market data
 */
export const quickswapProvider: Provider = {
  name: 'QUICKSWAP_PROVIDER',
  description: 'Provides current Quickswap market information and context',

  get: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> => {
    try {
      const quickswapApiUrl =
        runtime.getSetting('QUICKSWAP_API_URL') || 'https://api.quickswap.exchange';

      return {
        text: `Connected to Quickswap at ${quickswapApiUrl}. Ready to fetch token data and execute trades.`,
        values: {
          quickswapApiUrl,
          serviceStatus: 'active',
          featuresAvailable: ['token_data', 'pair_data', 'swaps', 'liquidity'],
        },
        data: {
          timestamp: new Date().toISOString(),
          service: 'quickswap',
        },
      };
    } catch (error) {
      logger.error('Error in Quickswap provider:', error);
      return {
        text: 'Quickswap service is currently unavailable.',
        values: {
          serviceStatus: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        data: {
          timestamp: new Date().toISOString(),
          service: 'quickswap',
        },
      };
    }
  },
};

const plugin: Plugin = {
  name: 'quickswap',
  description: 'A plugin for interacting with Quickswap decentralized exchange on Polygon',
  config: {
    QUICKSWAP_API_URL: process.env.QUICKSWAP_API_URL,
    WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY,
  },
  async init(config: Record<string, string>) {
    logger.info('*** Initializing Quickswap plugin ***');
    try {
      const validatedConfig = await configSchema.parseAsync(config);

      // Set all environment variables at once
      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value) process.env[key] = value;
      }

      logger.info('Quickswap plugin initialized successfully');
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(
          `Invalid Quickswap plugin configuration: ${error.errors.map((e) => e.message).join(', ')}`
        );
      }
      throw error;
    }
  },
  services: [QuickswapService],
  actions: [
    initializeQuickswapPluginAction,
    fetchTokenDataAction,
    fetchPairDataAction,
    swapTokensAction,
    addLiquidityAction,
    removeLiquidityAction,
    getTransactionStatusAction,
    calculateLiquidityValueAction,
    calculateMidPriceAction,
    calculateTokenPriceAction,
    executeLimitOrderStopLossTakeProfitAction,
    supportFeeOnTransferTokensAction,
    calculatePriceImpactAction,
    getFarmingPoolDetailsAction,
    estimateGasFeesAction,
    claimFarmingRewardsAction,
  ],
  providers: [quickswapProvider],
};

export default plugin;
