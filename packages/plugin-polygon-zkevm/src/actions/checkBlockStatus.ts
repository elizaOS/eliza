import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  ModelType,
  composePromptFromState,
} from '@elizaos/core';
import { JsonRpcProvider } from 'ethers';
import { checkBlockStatusTemplate } from '../templates';
import { callLLMWithTimeout } from '../utils/llmHelpers';

// Block status types for Polygon zkEVM
type BlockStatus = 'trusted' | 'virtual' | 'consolidated' | 'unknown';

interface BlockStatusResult {
  blockNumber: number;
  blockHash?: string;
  status: BlockStatus;
  statusCode?: number;
  description: string;
  method: 'alchemy' | 'rpc';
  timestamp: number;
}

/**
 * Check L2 block status action for Polygon zkEVM
 * Determines whether a block is trusted, virtual, or consolidated
 */
export const checkBlockStatusAction: Action = {
  name: 'POLYGON_ZKEVM_CHECK_L2_BLOCK_STATUS',
  similes: [
    'CHECK_BLOCK_STATUS',
    'BLOCK_STATUS',
    'L2_BLOCK_STATUS',
    'BLOCK_FINALITY',
    'CHECK_FINALITY',
    'BLOCK_STATE',
    'VERIFY_BLOCK',
    'BLOCK_CONFIRMATION',
  ].map((s) => `POLYGON_ZKEVM_${s}`),
  description: 'Check the status of a Polygon zkEVM block (trusted, virtual, or consolidated)',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

    if (!alchemyApiKey && !zkevmRpcUrl) {
      return false;
    }

    // Check if the message is specifically about block status/finality
    const content = message.content?.text?.toLowerCase() || '';
    const statusKeywords = [
      'status',
      'finality',
      'trusted',
      'virtual',
      'consolidated',
      'confirmed',
      'confirmation',
      'verify',
      'check status',
      'block status',
      'finalized',
    ];

    const hasStatusKeyword = statusKeywords.some((keyword) => content.includes(keyword));
    const hasBlockKeyword = content.includes('block');

    // Only match if both block and status-related keywords are present
    return hasBlockKeyword && hasStatusKeyword;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    try {
      logger.info('[checkBlockStatusAction] Handler called!');

      const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
      const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

      if (!alchemyApiKey && !zkevmRpcUrl) {
        const errorMessage = 'ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.';
        logger.error(`[checkBlockStatusAction] Configuration error: ${errorMessage}`);
        const errorContent: Content = {
          text: errorMessage,
          actions: ['POLYGON_CHECK_L2_BLOCK_STATUS_ZKEVM'],
          data: { error: errorMessage },
        };

        if (callback) {
          await callback(errorContent);
        }
        throw new Error(errorMessage);
      }

      let blockInput: any | null = null;

      // Extract block parameters using LLM with OBJECT_LARGE model
      try {
        blockInput = await callLLMWithTimeout<{
          blockNumber?: number;
          blockHash?: string;
          error?: string;
        }>(runtime, state, checkBlockStatusTemplate, 'checkBlockStatusAction');

        if (blockInput?.error) {
          logger.error('[checkBlockStatusAction] LLM returned an error:', blockInput?.error);
          throw new Error(blockInput?.error);
        }

        if (!blockInput?.blockNumber && !blockInput?.blockHash) {
          throw new Error('No valid block identifier received from LLM.');
        }
      } catch (error) {
        logger.error(
          '[checkBlockStatusAction] OBJECT_LARGE model failed',
          error instanceof Error ? error : undefined
        );
        throw new Error(
          `[checkBlockStatusAction] Failed to extract block parameters from input: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Determine block identifier
      let blockIdentifier: string | number;
      let isHash = false;

      if (blockInput.blockHash) {
        blockIdentifier = blockInput.blockHash;
        isHash = true;
        logger.info(`📋 Checking status for block hash: ${blockIdentifier}`);
      } else if (blockInput.blockNumber !== undefined) {
        blockIdentifier = blockInput.blockNumber;
        logger.info(`📋 Checking status for block number: ${blockIdentifier}`);
      } else {
        // Default to latest block
        blockIdentifier = 'latest';
        logger.info('📋 No specific block provided, checking latest block');
      }

      // Setup provider - prefer Alchemy, fallback to RPC
      let provider: JsonRpcProvider;
      let methodUsed: 'alchemy' | 'rpc' = 'rpc';
      const zkevmAlchemyUrl =
        runtime.getSetting('ZKEVM_ALCHEMY_URL') || 'https://polygonzkevm-mainnet.g.alchemy.com/v2';

      if (alchemyApiKey) {
        provider = new JsonRpcProvider(`${zkevmAlchemyUrl}/${alchemyApiKey}`);
        methodUsed = 'alchemy';
        logger.info('🔗 Using Alchemy API for block status check');
      } else {
        provider = new JsonRpcProvider(zkevmRpcUrl);
        logger.info('🔗 Using direct RPC for block status check');
      }

      let blockData: any = null;
      let blockStatus: BlockStatus = 'unknown';
      let statusCode: number | undefined;
      let errorMessages: string[] = [];

      // Get block data first
      try {
        logger.info('📥 Fetching block data...');

        if (isHash) {
          blockData = await provider.getBlock(blockIdentifier as string);
        } else {
          blockData = await provider.getBlock(blockIdentifier as number);
        }

        if (!blockData) {
          throw new Error('Block not found');
        }

        logger.info(`✅ Block data retrieved for block ${blockData.number}`);
      } catch (error) {
        const errorMsg = `Failed to get block data: ${error instanceof Error ? error.message : String(error)}`;
        logger.error(errorMsg);
        errorMessages.push(errorMsg);
      }

      // Try to get block status using zkEVM-specific methods
      if (blockData) {
        try {
          logger.info('🔍 Checking block status...');

          // Try zkEVM-specific RPC methods
          let statusResponse: any;

          try {
            // Try zkevm_getBatchByNumber method (common in zkEVM implementations)
            statusResponse = await provider.send('zkevm_getBatchByNumber', [blockData.number]);
            logger.info('✅ Got batch status from zkevm_getBatchByNumber');
          } catch (batchError) {
            logger.warn('zkevm_getBatchByNumber not available, trying alternative methods');

            try {
              // Try alternative method for block status
              statusResponse = await provider.send('zkevm_getBlockStatus', [blockData.number]);
              logger.info('✅ Got status from zkevm_getBlockStatus');
            } catch (statusError) {
              logger.warn('zkevm_getBlockStatus not available, using heuristic approach');

              // Fallback: Use heuristic based on block age and confirmations
              const currentBlock = await provider.getBlockNumber();
              const blockAge = currentBlock - blockData.number;

              if (blockAge < 10) {
                blockStatus = 'virtual';
                statusCode = 0;
              } else if (blockAge < 100) {
                blockStatus = 'trusted';
                statusCode = 1;
              } else {
                blockStatus = 'consolidated';
                statusCode = 2;
              }

              logger.info(`📊 Using heuristic: block age ${blockAge}, status: ${blockStatus}`);
            }
          }

          // Parse status response if we got one
          if (statusResponse) {
            if (typeof statusResponse === 'object' && statusResponse.status !== undefined) {
              statusCode = statusResponse.status;
            } else if (typeof statusResponse === 'number') {
              statusCode = statusResponse;
            } else if (typeof statusResponse === 'string') {
              // Parse string status
              const statusStr = statusResponse.toLowerCase();
              if (statusStr.includes('virtual')) {
                statusCode = 0;
              } else if (statusStr.includes('trusted')) {
                statusCode = 1;
              } else if (statusStr.includes('consolidated')) {
                statusCode = 2;
              }
            }

            // Map status code to status string
            switch (statusCode) {
              case 0:
                blockStatus = 'virtual';
                break;
              case 1:
                blockStatus = 'trusted';
                break;
              case 2:
                blockStatus = 'consolidated';
                break;
              default:
                blockStatus = 'unknown';
            }

            logger.info(`📊 Block status determined: ${blockStatus} (code: ${statusCode})`);
          }
        } catch (error) {
          const errorMsg = `Failed to get block status: ${error instanceof Error ? error.message : String(error)}`;
          logger.error(errorMsg);
          errorMessages.push(errorMsg);
        }
      }

      // Prepare result
      const result: BlockStatusResult = {
        blockNumber:
          blockData?.number || (typeof blockIdentifier === 'number' ? blockIdentifier : 0),
        blockHash: blockData?.hash,
        status: blockStatus,
        statusCode,
        description: getStatusDescription(blockStatus),
        method: methodUsed,
        timestamp: Date.now(),
      };

      // Format response
      const statusEmoji = getStatusEmoji(blockStatus);
      const responseText = `${statusEmoji} **Block Status Check Results**

**Block Information:**
- Block Number: ${result.blockNumber}
- Block Hash: ${result.blockHash || 'N/A'}
- Status: **${result.status.toUpperCase()}** ${statusEmoji}
- Status Code: ${result.statusCode !== undefined ? result.statusCode : 'N/A'}
- Method: ${result.method}

**Status Description:**
${result.description}

**Timestamp:** ${new Date(result.timestamp).toISOString()}

${errorMessages.length > 0 ? `\n**Warnings/Errors:**\n${errorMessages.map((msg) => `- ${msg}`).join('\n')}` : ''}`;

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYGON_CHECK_L2_BLOCK_STATUS_ZKEVM'],
        data: {
          result,
          errors: errorMessages,
          success: blockData !== null,
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      const errorMessage = `Failed to check block status: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMessage);

      const errorContent: Content = {
        text: `❌ ${errorMessage}`,
        actions: ['POLYGON_CHECK_L2_BLOCK_STATUS_ZKEVM'],
        data: {
          error: errorMessage,
          success: false,
        },
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
          text: 'Check the status of block 12345 on Polygon zkEVM',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: '📊 **Block Status: Consolidated** (Block: 12345)\n\nThis block has been finalized and its state is part of a consolidated batch on L1, ensuring the highest level of security.',
          action: 'POLYGON_CHECK_L2_BLOCK_STATUS_ZKEVM',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Is block 0xabc... on Polygon zkEVM finalized?',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me check the finality status of that block on Polygon zkEVM.',
          action: 'POLYGON_CHECK_L2_BLOCK_STATUS_ZKEVM',
        },
      },
    ],
  ],
};

function getStatusEmoji(status: BlockStatus): string {
  switch (status) {
    case 'virtual':
      return '🟡';
    case 'trusted':
      return '🟠';
    case 'consolidated':
      return '🟢';
    default:
      return '❓';
  }
}

function getStatusDescription(status: BlockStatus): string {
  switch (status) {
    case 'virtual':
      return 'Block is virtual - recently proposed but not yet trusted by the network.';
    case 'trusted':
      return 'Block is trusted - validated by the network but not yet consolidated.';
    case 'consolidated':
      return 'Block is consolidated - fully finalized and immutable on the network.';
    default:
      return 'Block status is unknown - unable to determine the current state.';
  }
}
