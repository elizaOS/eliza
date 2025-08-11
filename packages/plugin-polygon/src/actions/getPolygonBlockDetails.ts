import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  type Content,
  logger,
} from '@elizaos/core';
import { PolygonRpcService } from '../services/PolygonRpcService.js';

export const getPolygonBlockDetailsAction: Action = {
  name: 'POLYGON_GET_BLOCK_DETAILS',
  similes: ['SHOW_BLOCK_INFO', 'GET_BLOCK_DATA', 'CHECK_BLOCK_DETAILS', 'GET_BLOCK_INFO'].map(
    (s) => `POLYGON_${s}`
  ),
  description: 'Gets details for a specific block on Polygon by number or hash.',
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const content = message.content?.text?.toLowerCase() || '';

    // Add debug logging to see if this is being called
    logger.info(`[getPolygonBlockDetailsAction] VALIDATION CALLED - message: "${content}"`);

    try {
      // Check for block details related keywords
      const blockDetailsKeywords = [
        'block details',
        'details of block',
        'details of the block',
        'get the details of block',
        'get the details of the block',
        'get details of block',
        'get details of the block',
        'polygon block details',
        'polygon block information',
        'block information',
        'get details',
        'show me block',
        'details for block',
        'get me the polygon block',
        'show polygon block',
        'polygon block info',
        'block info',
        'show block details',
        'get block details',
        'block data',
        'get block data',
      ];

      const matches = blockDetailsKeywords.some((keyword) => content.includes(keyword));

      // Also check if there's a block number mentioned
      const hasBlockNumber = /block\s+\d+|details.*\d+/.test(content);

      const result = matches || hasBlockNumber;
      logger.info(
        `[getPolygonBlockDetailsAction] Validation result: ${result} (keywords: ${matches}, hasBlockNumber: ${hasBlockNumber})`
      );

      // Also check if we have required services
      const rpcService = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!rpcService) {
        logger.warn(
          `[getPolygonBlockDetailsAction] PolygonRpcService not available - validation false`
        );
        return false;
      }

      return result;
    } catch (error) {
      logger.error(`[getPolygonBlockDetailsAction] Validation error:`, error);
      return false;
    }
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getPolygonBlockDetailsAction] Handler called!');

    const rpcService = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
    if (!rpcService) {
      throw new Error('PolygonRpcService not available');
    }

    try {
      // Extract block number from the message or use current block
      const content = message.content?.text || '';
      let blockNumber: number;

      // Try to extract block number from message with improved regex
      const blockNumberMatches = [
        /block\s+(\d+)/i,
        /details.*block\s+(\d+)/i,
        /details.*of.*(\d+)/i,
        /get.*details.*(\d+)/i,
        /(\d{7,})/, // Match any large number (likely a block number)
      ];

      let extractedBlockNumber: string | null = null;
      for (const regex of blockNumberMatches) {
        const match = content.match(regex);
        if (match) {
          extractedBlockNumber = match[1];
          break;
        }
      }

      if (extractedBlockNumber) {
        blockNumber = parseInt(extractedBlockNumber);
        logger.info(`Extracted block number ${blockNumber} from message: "${content}"`);
      } else {
        // If no specific block number, use current block
        blockNumber = await rpcService.getCurrentBlockNumber();
        logger.info(`No block number found in message, using current block: ${blockNumber}`);
      }

      logger.info(`Getting details for Polygon block: ${blockNumber}`);
      const blockDetails = await rpcService.getBlockDetails(blockNumber);

      if (!blockDetails) {
        const notFoundContent: Content = {
          text: `Block ${blockNumber} not found on Polygon.`,
          actions: ['GET_POLYGON_BLOCK_DETAILS'],
          data: { blockNumber, found: false },
        };

        if (callback) {
          await callback(notFoundContent);
        }

        return notFoundContent;
      }

      const responseContent: Content = {
        text:
          `Polygon Block ${blockNumber} Details:\n` +
          `- Hash: ${blockDetails.hash}\n` +
          `- Parent Hash: ${blockDetails.parentHash}\n` +
          `- Timestamp: ${new Date(blockDetails.timestamp * 1000).toISOString()}\n` +
          `- Gas Used: ${blockDetails.gasUsed.toString()}\n` +
          `- Gas Limit: ${blockDetails.gasLimit.toString()}\n` +
          `- Transaction Count: ${blockDetails.transactions.length}\n` +
          `- Miner: ${blockDetails.miner}`,
        actions: ['GET_POLYGON_BLOCK_DETAILS'],
        data: {
          blockNumber,
          blockDetails: {
            hash: blockDetails.hash,
            parentHash: blockDetails.parentHash,
            timestamp: blockDetails.timestamp,
            gasUsed: blockDetails.gasUsed.toString(),
            gasLimit: blockDetails.gasLimit.toString(),
            transactionCount: blockDetails.transactions.length,
            miner: blockDetails.miner,
          },
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      logger.error('Error getting Polygon block details:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      const errorContent: Content = {
        text: `Error retrieving Polygon block details: ${errorMessage}`,
        actions: ['GET_POLYGON_BLOCK_DETAILS'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }

      return errorContent;
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'get me the details of polygon block 42000000',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Polygon Block 42000000 Details:\n- Hash: 0x1234...\n- Parent Hash: 0x5678...\n- Timestamp: 2024-01-01T00:00:00.000Z\n- Gas Used: 15000000\n- Gas Limit: 30000000\n- Transaction Count: 150\n- Miner: 0xabcd...',
          action: 'POLYGON_GET_POLYGON_BLOCK_DETAILS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'show me the polygon block details',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Polygon Block 65123456 Details:\n- Hash: 0x1234...\n- Parent Hash: 0x5678...\n- Timestamp: 2024-01-01T00:00:00.000Z\n- Gas Used: 15000000\n- Gas Limit: 30000000\n- Transaction Count: 150\n- Miner: 0xabcd...',
          action: 'POLYGON_GET_POLYGON_BLOCK_DETAILS',
        },
      },
    ],
  ],
};
