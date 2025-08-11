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
import { getBatchInfoTemplate } from '../templates';
import { callLLMWithTimeout } from '../utils/llmHelpers';

interface BatchInfo {
  batchNumber: number;
  blockRange?: {
    start: number;
    end: number;
  };
  status?: string;
  timestamp?: number;
  transactionCount?: number;
  method: 'alchemy' | 'rpc';
}

export const getBatchInfoAction: Action = {
  name: 'POLYGON_ZKEVM_GET_BATCH_INFO',
  similes: ['GET_BATCH', 'BATCH_INFO', 'BATCH_DETAILS', 'BATCH'].map((s) => `POLYGON_ZKEVM_${s}`),
  description: 'Gets information about a specific batch on Polygon zkEVM.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

    if (!alchemyApiKey && !zkevmRpcUrl) {
      return false;
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getBatchInfoAction] Handler called!');

    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

    if (!alchemyApiKey && !zkevmRpcUrl) {
      const errorMessage = 'ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.';
      logger.error(`[getBatchInfoAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYGON_ZKEVM_GET_BATCH_INFO'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    let batchInput: any | null = null;

    // Extract batch number using LLM with OBJECT_LARGE model
    try {
      batchInput = await callLLMWithTimeout<{ batchNumber: number; error?: string }>(
        runtime,
        state,
        getBatchInfoTemplate,
        'getBatchInfoAction'
      );

      if (batchInput?.error) {
        logger.error('[getBatchInfoAction] LLM returned an error:', batchInput?.error);
        throw new Error(batchInput?.error);
      }

      if (!batchInput?.batchNumber || typeof batchInput.batchNumber !== 'number') {
        throw new Error('Invalid batch number received from LLM.');
      }
    } catch (error) {
      logger.debug(
        '[getBatchInfoAction] OBJECT_LARGE model failed',
        error instanceof Error ? error : undefined
      );
      throw new Error(
        `[getBatchInfoAction] Failed to extract batch number from input: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const batchNumber = batchInput.batchNumber;

    // Setup provider - prefer Alchemy, fallback to RPC
    let provider: JsonRpcProvider;
    let methodUsed: 'alchemy' | 'rpc' = 'rpc';
    const zkevmAlchemyUrl =
      runtime.getSetting('ZKEVM_ALCHEMY_URL') || 'https://polygonzkevm-mainnet.g.alchemy.com/v2';

    if (alchemyApiKey) {
      provider = new JsonRpcProvider(`${zkevmAlchemyUrl}/${alchemyApiKey}`);
      methodUsed = 'alchemy';
    } else {
      provider = new JsonRpcProvider(zkevmRpcUrl);
    }

    let batchInfo: BatchInfo | null = null;
    let errorMessages: string[] = [];

    // Try to get batch information
    try {
      logger.info(`[getBatchInfoAction] Fetching batch info for batch ${batchNumber}`);

      // Try zkEVM-specific RPC methods
      let batchData: any;

      try {
        // Try zkevm_getBatchByNumber method
        batchData = await provider.send('zkevm_getBatchByNumber', [batchNumber]);
        logger.info('[getBatchInfoAction] Got batch data from zkevm_getBatchByNumber');
      } catch (batchError) {
        logger.warn(
          '[getBatchInfoAction] zkevm_getBatchByNumber not available, trying alternative methods'
        );

        try {
          // Try alternative method
          batchData = await provider.send('zkevm_getBatch', [batchNumber]);
          logger.info('[getBatchInfoAction] Got batch data from zkevm_getBatch');
        } catch (altError) {
          logger.warn('[getBatchInfoAction] Alternative batch methods not available');
          throw new Error('Batch information not available via RPC methods');
        }
      }

      if (batchData) {
        batchInfo = {
          batchNumber,
          blockRange: batchData.blockRange || undefined,
          status: batchData.status || 'unknown',
          timestamp: batchData.timestamp || Date.now(),
          transactionCount: batchData.transactionCount || 0,
          method: methodUsed,
        };
      }
    } catch (error) {
      const errorMsg = `Failed to get batch info: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMsg);
      errorMessages.push(errorMsg);
    }

    if (batchInfo) {
      const responseText = `📦 **Batch Information (Polygon zkEVM)**

**Batch Number:** ${batchInfo.batchNumber}
**Status:** ${batchInfo.status}
**Block Range:** ${batchInfo.blockRange ? `${batchInfo.blockRange.start} - ${batchInfo.blockRange.end}` : 'N/A'}
**Transaction Count:** ${batchInfo.transactionCount || 'N/A'}
**Method:** ${batchInfo.method}

${errorMessages.length > 0 ? `\n**Warnings:**\n${errorMessages.map((msg) => `- ${msg}`).join('\n')}` : ''}`;

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYGON_ZKEVM_GET_BATCH_INFO'],
        data: {
          batchInfo,
          network: 'polygon-zkevm',
          timestamp: Date.now(),
          method: methodUsed,
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } else {
      const errorMessage = `Failed to retrieve batch information for batch ${batchNumber}. ${errorMessages.join('; ')}`;
      logger.error(errorMessage);

      const errorContent: Content = {
        text: `❌ ${errorMessage}`,
        actions: ['POLYGON_ZKEVM_GET_BATCH_INFO'],
        data: { error: errorMessage, errors: errorMessages, batchNumber },
      };

      if (callback) {
        await callback(errorContent);
      }

      throw new Error(errorMessage);
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Get batch info for batch 123 on Polygon zkEVM',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll get the batch information for batch 123 on Polygon zkEVM.",
          action: 'POLYGON_ZKEVM_GET_BATCH_INFO',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Show details for zkEVM batch 456 on Polygon zkEVM',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me fetch the details for that batch on Polygon zkEVM.',
          action: 'POLYGON_ZKEVM_GET_BATCH_INFO',
        },
      },
    ],
  ],
};
