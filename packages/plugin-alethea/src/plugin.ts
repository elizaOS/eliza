import type { Plugin } from '@elizaos/core';
import { type Action, type IAgentRuntime, Service, logger } from '@elizaos/core';
import { z } from 'zod';
import {
  convertNftToAliAgentAction,
  convertInftToAliAgentAction,
  getAliAgentKeyBuyPriceAction,
  getAliAgentKeySellPriceAction,
  buyKeysAction,
  sellKeysAction,
  fusePodWithAliAgentAction,
  distributeHiveTokensAction,
  createLiquidityPoolAction,
  deployAliAgentTokenAction,
  deployHiveUtilityTokenAction,
  executeAirdropAction,
  createHiveAction,
  updateHiveUriAction,
  joinHiveAction,
  leaveHiveAction,
  getLinkedAssetDetailsAction,
  handleGovernanceErrorsAction,
  participateInVoteAction,
  // Other actions will be added here
} from './actions'; // Import from actions/index.ts

/**
 * Define the configuration schema for the Alethea AI plugin
 */
const configSchema = z.object({
  ALETHEA_RPC_URL: z
    .string()
    .url('ALETHEA_RPC_URL must be a valid URL')
    .min(1, 'ALETHEA_RPC_URL cannot be empty'),
  PRIVATE_KEY: z
    .string()
    .min(1, 'PRIVATE_KEY cannot be empty')
    .transform((val) => {
      if (!val) {
        throw new Error('PRIVATE_KEY is required for Alethea AI operations');
      }
      return val;
    }),
  ALETHEA_API_KEY: z.string().min(1, 'ALETHEA_API_KEY cannot be empty').optional(),
  // Optional: Default Pod NFT Contract address if not provided in action call
  POD_NFT_CONTRACT_ADDRESS: z
    .string()
    .startsWith('0x', { message: 'Pod NFT Contract address must start with 0x' })
    .length(42, { message: 'Pod NFT Contract address must be 42 characters long' })
    .optional(),
});

/**
 * Alethea Service for managing connections and state
 */
export class AletheaService extends Service {
  static serviceType = 'alethea';
  capabilityDescription =
    'This service provides access to Alethea AI platform, including AliAgents, INFTs, Hive, tokens, and governance.';

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime) {
    logger.info('*** Starting Alethea AI service ***');
    const service = new AletheaService(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime) {
    logger.info('*** Stopping Alethea AI service ***');
    const service = runtime.getService(AletheaService.serviceType);
    if (!service) {
      throw new Error('Alethea AI service not found');
    }
    service.stop();
  }

  async stop() {
    logger.info('*** Stopping Alethea AI service instance ***');
  }
}

// Placeholder action arrays for different Alethea AI functionalities
// These will be populated in subsequent tickets

/**
 * Actions for AliAgent management (create, update, query)
 */
export const aliAgentActions: Action[] = [
  convertNftToAliAgentAction,
  convertInftToAliAgentAction,
  getAliAgentKeyBuyPriceAction,
  getAliAgentKeySellPriceAction,
  buyKeysAction,
  sellKeysAction,
  fusePodWithAliAgentAction,
];

/**
 * Actions for intelligent NFT (INFT) operations
 */
export const inftActions: Action[] = [];

/**
 * Actions for Hive creation, membership, and messaging
 */
export const hiveActions: Action[] = [
  distributeHiveTokensAction,
  createLiquidityPoolAction,
  deployHiveUtilityTokenAction,
  createHiveAction,
  updateHiveUriAction,
  joinHiveAction,
  leaveHiveAction,
  getLinkedAssetDetailsAction,
  // Other hive actions will be added here
];

/**
 * Actions for token operations (transfer, balance check)
 */
export const tokenActions: Action[] = [deployAliAgentTokenAction, executeAirdropAction];

/**
 * Actions for governance operations (proposals, voting)
 */
export const governanceActions: Action[] = [
  handleGovernanceErrorsAction,
  participateInVoteAction,
  // Other governance actions will be added here
];

/**
 * Actions for market data retrieval and analysis
 */
export const marketDataActions: Action[] = [];

/**
 * The main Alethea AI plugin definition
 */
const plugin: Plugin = {
  name: 'alethea',
  description: 'A plugin for interacting with the Alethea AI platform',
  config: {
    ALETHEA_RPC_URL: process.env.ALETHEA_RPC_URL,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    ALETHEA_API_KEY: process.env.ALETHEA_API_KEY,
    POD_NFT_CONTRACT_ADDRESS: process.env.POD_NFT_CONTRACT_ADDRESS,
  },
  async init(config: Record<string, string>) {
    logger.info('*** Initializing Alethea AI plugin ***');
    try {
      const validatedConfig = await configSchema.parseAsync(config);

      // Set all environment variables at once
      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value) process.env[key] = value;
      }

      logger.info('Alethea AI plugin initialized successfully');
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(
          `Invalid Alethea AI plugin configuration: ${error.errors.map((e) => e.message).join(', ')}`
        );
      }
      throw error;
    }
  },
  services: [AletheaService],
  actions: [
    ...aliAgentActions,
    ...inftActions,
    ...hiveActions,
    ...tokenActions,
    ...governanceActions,
    ...marketDataActions,
  ],
  providers: [], // No providers for now, can be added later if needed
};

export default plugin;
