import { type Action, logger, type IAgentRuntime, type Memory, type State } from '@elizaos/core';
import { z } from 'zod';
import { formatUnits } from '../utils/formatters.js';
import { PolygonRpcService } from '../services/PolygonRpcService.js';
import { BlockInfo } from '../types.js';

// Action to get current block number from Polygon L2
export const getBlockNumberAction: Action = {
  name: 'GET_L2_BLOCK_NUMBER',
  description: 'Gets the current block number on Polygon (L2).',

  // Define examples for how to use this action
  examples: [
    [
      {
        name: 'User',
        content: { text: 'What is the current block number on Polygon?' },
      },
    ],
    [
      {
        name: 'User',
        content: { text: 'Get latest Polygon block height' },
      },
    ],
    [
      {
        name: 'User',
        content: { text: 'Fetch current block number for L2' },
      },
    ],
  ],

  // Validation function
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const content = message.content?.text?.toLowerCase() || '';

    // Check for block number related keywords
    const blockNumberKeywords = [
      'block number',
      'current block',
      'latest block',
      'polygon block number',
      'get polygon block',
      'block height',
      'current polygon block',
      'latest polygon block',
    ];

    return blockNumberKeywords.some((keyword) => content.includes(keyword));
  },

  // Actual handler function that performs the operation
  handler: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    logger.info('Getting current Polygon block number');

    // Get RPC service
    const rpcService = runtime.getService(PolygonRpcService.serviceType) as PolygonRpcService;
    if (!rpcService) {
      logger.error('PolygonRpcService not available');
      throw new Error('PolygonRpcService not available');
    }

    logger.info('Fetching the current block number from Polygon network...');

    // Fetch the current block number
    const blockNumber = await rpcService.getCurrentBlockNumber();

    logger.info(`Successfully retrieved current block number: ${blockNumber}`);

    return {
      text: `Current Polygon block number: ${blockNumber}`,
      actions: ['GET_L2_BLOCK_NUMBER'],
      data: { blockNumber },
    };
  },
};

// Block identifier schema using Zod
const blockIdentifierSchema = z.union([
  z.number().positive('Block number must be positive'),
  z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Block hash must be a valid hex string'),
]);

// Action to get detailed information about a specific block
export const getBlockDetailsAction: Action = {
  name: 'GET_L2_BLOCK_DETAILS',
  description: 'Gets detailed information about a specific block on Polygon (L2).',

  // Define examples for how to use this action
  examples: [
    [
      {
        name: 'User',
        content: { text: 'Show me details for block 12345678 on Polygon' },
      },
    ],
    [
      {
        name: 'User',
        content: {
          text: 'Get information about Polygon block 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        },
      },
    ],
    [
      {
        name: 'User',
        content: { text: 'What transactions are in Polygon block 12345678?' },
      },
    ],
  ],

  // Validation function
  validate: async (options: any, runtime: IAgentRuntime) => {
    try {
      // Check if POLYGON_RPC_URL is set in environment
      const polygonRpcUrl = runtime.getSetting('POLYGON_RPC_URL');
      if (!polygonRpcUrl) {
        return 'POLYGON_RPC_URL setting is required to get block information';
      }

      // If blockIdentifier is provided in options, validate it
      if (options?.blockIdentifier !== undefined) {
        blockIdentifierSchema.parse(options.blockIdentifier);
        return true;
      }

      // If no blockIdentifier in options, check environment settings
      const envBlockIdentifier = runtime.getSetting('BLOCK_IDENTIFIER');

      if (envBlockIdentifier) {
        // Try to parse as number first
        if (!isNaN(Number(envBlockIdentifier))) {
          const blockNumber = Number(envBlockIdentifier);
          if (blockNumber <= 0) {
            return 'Block number from environment must be positive';
          }
          return true;
        }

        // Try as hash
        if (
          typeof envBlockIdentifier === 'string' &&
          envBlockIdentifier.match(/^0x[a-fA-F0-9]{64}$/)
        ) {
          return true;
        }

        return 'BLOCK_IDENTIFIER in environment settings is not a valid block number or hash';
      }

      return 'Block identifier (number or hash) is required';
    } catch (error) {
      if (error instanceof z.ZodError) {
        return error.errors[0].message;
      }
      return 'Invalid block identifier format';
    }
  },

  // Actual handler function that performs the operation
  handler: async (runtime: IAgentRuntime, message: any, state: any, options: any) => {
    // Get RPC service
    const rpcService = runtime.getService(PolygonRpcService.serviceType) as PolygonRpcService;
    if (!rpcService) {
      logger.error('PolygonRpcService not available');
      throw new Error('PolygonRpcService not available');
    }

    // Get block identifier from options or environment
    let blockIdentifier = options?.blockIdentifier;

    // If not in options, try to get from environment
    if (blockIdentifier === undefined) {
      logger.debug('Block identifier not found in options, checking environment settings');
      const envBlockIdentifier = runtime.getSetting('BLOCK_IDENTIFIER');

      if (!envBlockIdentifier) {
        logger.error('Block identifier missing from both options and environment settings');
        throw new Error('Block identifier (number or hash) is required');
      }

      // Convert to number if it's a numeric string
      if (!isNaN(Number(envBlockIdentifier))) {
        blockIdentifier = Number(envBlockIdentifier);
      } else {
        blockIdentifier = envBlockIdentifier;
      }

      logger.info(`Using block identifier from environment settings: ${blockIdentifier}`);
    } else {
      logger.info(`Using block identifier from options: ${blockIdentifier}`);
    }

    logger.info(`Getting details for block ${blockIdentifier} from Polygon network...`);

    // Fetch block details
    const blockDetails = await rpcService.getBlockDetails(blockIdentifier);
    if (!blockDetails) {
      logger.warn(`Block ${blockIdentifier} not found on Polygon network`);
      return {
        text: `Block ${blockIdentifier} not found on Polygon.`,
        actions: ['GET_L2_BLOCK_DETAILS'],
        data: { blockIdentifier, found: false },
      };
    }

    logger.info(
      `Successfully retrieved details for block ${blockDetails.number} (hash: ${blockDetails.hash})`
    );
    logger.debug(
      `Block timestamp: ${new Date(Number(blockDetails.timestamp) * 1000).toISOString()}`
    );
    logger.debug(
      `Block gas used: ${blockDetails.gasUsed.toString()} / ${blockDetails.gasLimit.toString()}`
    );

    // Format timestamp for readability
    const timestamp = new Date(Number(blockDetails.timestamp) * 1000).toISOString();

    // Format the response
    const formattedGasLimit = formatUnits(blockDetails.gasLimit, 0);
    const formattedGasUsed = formatUnits(blockDetails.gasUsed, 0);
    const baseFeePerGas = blockDetails.baseFeePerGas
      ? formatUnits(blockDetails.baseFeePerGas, 9)
      : 'N/A';

    // Create human-readable response
    const text =
      `Block ${blockDetails.number} (${blockIdentifier}):\n` +
      `Hash: ${blockDetails.hash}\n` +
      `Parent Hash: ${blockDetails.parentHash}\n` +
      `Timestamp: ${timestamp}\n` +
      `Miner: ${blockDetails.miner}\n` +
      `Gas Limit: ${formattedGasLimit}\n` +
      `Gas Used: ${formattedGasUsed} (${((Number(blockDetails.gasUsed) * 100) / Number(blockDetails.gasLimit)).toFixed(2)}%)\n` +
      `Base Fee: ${baseFeePerGas} Gwei\n` +
      `Transaction Count: ${Array.isArray(blockDetails.transactions) ? blockDetails.transactions.length : 'Unknown'}`;

    logger.info(`Returning formatted block details for block ${blockDetails.number}`);

    return {
      text,
      actions: ['GET_L2_BLOCK_DETAILS'],
      data: { blockIdentifier, blockDetails, found: true },
    };
  },
};

const blockOptionsSchema = z
  .object({
    blockNumber: z.number().int().positive().optional(),
    blockHash: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/)
      .optional(),
  })
  .refine((data) => data.blockNumber !== undefined || data.blockHash !== undefined, {
    message: 'Either blockNumber or blockHash must be provided',
  });

/**
 * Action to get block information from Polygon (L2)
 */
export const getBlockInfoAction: Action = {
  name: 'GET_L2_BLOCK_INFO',
  description: 'Gets detailed information about a specific block on Polygon (L2).',

  // Define examples
  examples: [
    [
      {
        name: 'User',
        content: { text: "What's in block 42000000 on Polygon?" },
      },
    ],
    [
      {
        name: 'User',
        content: {
          text: 'Show me the details of block 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        },
      },
    ],
    [
      {
        name: 'User',
        content: { text: 'Get information about Polygon block 42000000' },
      },
    ],
  ],

  validate: async (options: any, runtime: IAgentRuntime) => {
    try {
      // Check if POLYGON_RPC_URL is set in environment
      const polygonRpcUrl = runtime.getSetting('POLYGON_RPC_URL');
      if (!polygonRpcUrl) {
        return 'POLYGON_RPC_URL setting is required to get block information';
      }

      // If no options provided, check if we have a default block number
      if (!options || (options && !options.blockNumber && !options.blockHash)) {
        return 'Either blockNumber or blockHash must be provided';
      }

      // Validate options format
      blockOptionsSchema.parse(options);
      return true;
    } catch (error) {
      if (error instanceof z.ZodError) {
        logger.error('Validation error:', error.errors);
        return error.errors[0].message;
      }
      logger.error('Unexpected validation error:', error);
      return 'Invalid block options';
    }
  },

  execute: async (options: any, runtime: IAgentRuntime) => {
    try {
      // Get block identifier from options
      const blockIdentifier = options.blockNumber || options.blockHash;

      logger.info(`Getting details for block ${blockIdentifier}`);

      // Get the RPC service
      const rpcService = runtime.getService(PolygonRpcService.serviceType) as PolygonRpcService;
      if (!rpcService) {
        throw new Error('PolygonRpcService not available');
      }

      // Get block details
      logger.info(`Fetching block details from Polygon network...`);
      const blockInfo = await rpcService.getBlockDetails(blockIdentifier);

      if (!blockInfo) {
        logger.warn(`Block ${blockIdentifier} not found`);
        return {
          actions: ['GET_L2_BLOCK_INFO'],
          data: { error: `Block ${blockIdentifier} not found` },
        };
      }

      logger.info(`Successfully retrieved details for block ${blockInfo.number}`);

      // Format values for readability
      const timestamp = new Date(Number(blockInfo.timestamp) * 1000).toISOString();
      const gasLimit = formatUnits(blockInfo.gasLimit, 0);
      const gasUsed = formatUnits(blockInfo.gasUsed, 0);
      const baseFeePerGas = blockInfo.baseFeePerGas
        ? formatUnits(blockInfo.baseFeePerGas, 9)
        : 'N/A';

      logger.info(`Block number: ${blockInfo.number}`);
      logger.info(`Block timestamp: ${timestamp}`);
      logger.info(
        `Gas used: ${gasUsed} / ${gasLimit} (${((Number(blockInfo.gasUsed) * 100) / Number(blockInfo.gasLimit)).toFixed(2)}%)`
      );
      logger.info(`Transactions: ${blockInfo.transactions.length}`);

      return {
        actions: ['GET_L2_BLOCK_INFO'],
        data: {
          number: blockInfo.number,
          hash: blockInfo.hash,
          parentHash: blockInfo.parentHash,
          timestamp,
          gasLimit,
          gasUsed,
          baseFeePerGas,
          miner: blockInfo.miner,
          transactionCount: blockInfo.transactions.length,
        },
      };
    } catch (error) {
      logger.error(`Error getting block details:`, error);
      return {
        actions: ['GET_L2_BLOCK_INFO'],
        data: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  },
};
