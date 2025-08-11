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
import { getCurrentBlockNumberAction } from './actions/getCurrentBlockNumber';
import { getBalanceAction } from './actions/getBalance';
import { getTransactionByHashAction } from './actions/getTransactionByHash';
import { getTransactionReceiptAction } from './actions/getTransactionReceipt';
import { getGasPriceAction } from './actions/getGasPrice';
import { getTransactionCountAction } from './actions/getTransactionCount';
import { getCodeAction } from './actions/getCode';
import { getStorageAtAction } from './actions/getStorageAt';
import { getLogsAction } from './actions/getLogs';
import { estimateGasAction } from './actions/estimateGas';
import { getTransactionDetailsAction } from './actions/getTransactionDetails';
import { getAccountBalanceAction } from './actions/getAccountBalance';
import { getGasPriceEstimatesAction } from './actions/getGasPriceEstimates';
import { checkBlockStatusAction } from './actions/checkBlockStatus';
import { getBatchInfoAction } from './actions/getBatchInfo';
import { deploySmartContractAction } from './actions/deploySmartContract';
import { interactSmartContractAction } from './actions/interactSmartContract';
import { bridgeAssetsAction } from './actions/bridgeAssets';
import { bridgeMessagesAction } from './actions/bridgeMessages';
import { estimateTransactionFeeAction } from './actions/estimateTransactionFee';
import { getBlockDetailsByNumberAction } from './actions/getBlockDetailsByNumber';
import { getBlockDetailsByHashAction } from './actions/getBlockDetailsByHash';

/**
 * Define the configuration schema for the plugin with the following properties:
 *
 * @param {string} EXAMPLE_PLUGIN_VARIABLE - The name of the plugin (min length of 1, optional)
 * @returns {object} - The configured schema object
 */
const configSchema = z
  .object({
    EXAMPLE_PLUGIN_VARIABLE: z
      .string()
      .min(1, 'Example plugin variable is not provided')
      .optional()
      .transform((val) => {
        if (!val) {
          console.warn('Warning: Example plugin variable is not provided');
        }
        return val;
      }),
    // Add Polygon zkEVM specific configuration to the schema
    ALCHEMY_API_KEY: z.string().min(1, 'ALCHEMY_API_KEY is required').optional(), // Making optional here as RPC is a fallback
    ZKEVM_RPC_URL: z.string().url('Invalid ZKEVM_RPC_URL').optional(), // Making optional here as Alchemy is primary
    PRIVATE_KEY: z.string().min(1, 'PRIVATE_KEY is required').optional(), // Keeping optional for now as it's not used in block number action
  })
  .refine((data) => data.ALCHEMY_API_KEY || data.ZKEVM_RPC_URL, {
    // Ensure at least one of the endpoints is provided
    message: 'Either ALCHEMY_API_KEY or ZKEVM_RPC_URL must be provided',
  });

/**
 * Example HelloWorld action
 * This demonstrates the simplest possible action structure
 */
/**
 * Represents an action that responds with a simple hello world message.
 *
 * @typedef {Object} Action
 * @property {string} name - The name of the action
 * @property {string[]} similes - The related similes of the action
 * @property {string} description - Description of the action
 * @property {Function} validate - Validation function for the action
 * @property {Function} handler - The function that handles the action
 * @property {Object[]} examples - Array of examples for the action
 */
const helloWorldAction: Action = {
  name: 'HELLO_WORLD',
  similes: ['GREET', 'SAY_HELLO'],
  description: 'Responds with a simple hello world message',

  validate: async (_runtime: IAgentRuntime, _message: Memory, _state: State): Promise<boolean> => {
    // Always valid
    return true;
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: any,
    callback: HandlerCallback,
    _responses: Memory[]
  ) => {
    try {
      logger.info('Handling HELLO_WORLD action');

      // Simple response content
      const responseContent: Content = {
        text: 'hello world!',
        actions: ['HELLO_WORLD'],
        source: message.content.source,
      };

      // Call back with the hello world message
      await callback(responseContent);

      return responseContent;
    } catch (error) {
      logger.error('Error in HELLO_WORLD action:', error);
      throw error;
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Can you say hello?',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'hello world!',
          actions: ['HELLO_WORLD'],
        },
      },
    ],
  ],
};

/**
 * Example Hello World Provider
 * This demonstrates the simplest possible provider implementation
 */
const helloWorldProvider: Provider = {
  name: 'HELLO_WORLD_PROVIDER',
  description: 'A simple example provider',

  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    return {
      text: 'I am a provider',
      values: {},
      data: {},
    };
  },
};

export class StarterService extends Service {
  static serviceType = 'starter';
  capabilityDescription =
    'This is a starter service which is attached to the agent through the starter plugin.';

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime) {
    logger.info('*** Starting starter service ***');
    const service = new StarterService(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime) {
    logger.info('*** Stopping starter service ***');
    // get the service from the runtime
    const service = runtime.getService(StarterService.serviceType);
    if (!service) {
      throw new Error('Starter service not found');
    }
    service.stop();
  }

  async stop() {
    logger.info('*** Stopping starter service instance ***');
  }
}

const plugin: Plugin = {
  name: 'polygon-zkevm',
  description: 'A plugin for interacting with Polygon zkEVM',
  config: {
    // Configuration will be loaded and validated in the init function
  },
  async init(config: Record<string, string>, runtime: IAgentRuntime) {
    logger.info('*** Initializing Polygon zkEVM plugin ***');
    try {
      // Get configuration from runtime settings or environment variables
      const configToValidate = {
        ALCHEMY_API_KEY: runtime.getSetting('ALCHEMY_API_KEY') || process.env.ALCHEMY_API_KEY,
        ZKEVM_RPC_URL: runtime.getSetting('ZKEVM_RPC_URL') || process.env.ZKEVM_RPC_URL,
        PRIVATE_KEY: runtime.getSetting('PRIVATE_KEY') || process.env.PRIVATE_KEY,
      };

      const validatedConfig = await configSchema.parseAsync(configToValidate);
      logger.info('Polygon zkEVM plugin configuration validated successfully.');
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(
          `Invalid Polygon zkEVM plugin configuration: ${error.errors.map((e) => e.message).join(', ')}`
        );
      }
      throw error;
    }
  },
  // Remove mock models to allow real AI models to work
  models: {},
  routes: [
    // Removed the misplaced helloWorld route definition
  ],
  events: {
    MESSAGE_RECEIVED: [
      async (params) => {
        logger.info('MESSAGE_RECEIVED event received');
        // print the keys
        logger.info(Object.keys(params));
      },
    ],
    VOICE_MESSAGE_RECEIVED: [
      async (params) => {
        logger.info('VOICE_MESSAGE_RECEIVED event received');
        // print the keys
        logger.info(Object.keys(params));
      },
    ],
    WORLD_CONNECTED: [
      async (params) => {
        logger.info('WORLD_CONNECTED event received');
        // print the keys
        logger.info(Object.keys(params));
      },
    ],
    WORLD_JOINED: [
      async (params) => {
        logger.info('WORLD_JOINED event received');
        // print the keys
        logger.info(Object.keys(params));
      },
    ],
  },
  services: [StarterService],
  actions: [
    helloWorldAction,
    getCurrentBlockNumberAction,
    getBalanceAction,
    getTransactionByHashAction,
    getTransactionReceiptAction,
    getGasPriceAction,
    getTransactionCountAction,
    getCodeAction,
    getStorageAtAction,
    getLogsAction,
    estimateGasAction,
    estimateTransactionFeeAction,
    getTransactionDetailsAction,
    getAccountBalanceAction,
    getGasPriceEstimatesAction,
    checkBlockStatusAction,
    getBatchInfoAction,
    deploySmartContractAction,
    interactSmartContractAction,
    bridgeAssetsAction,
    bridgeMessagesAction,
    getBlockDetailsByNumberAction,
    getBlockDetailsByHashAction,
  ],
  providers: [helloWorldProvider],
};

export default plugin;
