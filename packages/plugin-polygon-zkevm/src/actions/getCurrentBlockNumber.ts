import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  type Content,
  logger,
  composePromptFromState,
  ModelType,
  parseJSONObjectFromText,
} from '@elizaos/core';
import { JsonRpcProvider } from 'ethers';
import { getCurrentBlockNumberTemplate } from '../templates';

interface CurrentBlockParams {
  requestCurrentBlock?: boolean;
  error?: string;
}

export const getCurrentBlockNumberAction: Action = {
  name: 'POLYGON_ZKEVM_GET_CURRENT_BLOCK_NUMBER',
  similes: [
    'GET_CURRENT_L2_BLOCK_NUMBER',
    'CHECK_BLOCK',
    'SHOW_LATEST_BLOCK',
    'BLOCK_NUMBER',
    'GET_BLOCK_NUMBER',
    'GET_L2_BLOCK_NUMBER',
  ].map((s) => `POLYGON_ZKEVM_${s}`),
  description: 'Gets the current block number on Polygon zkEVM (Layer 2 zero-knowledge rollup).',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

    // If no API configuration is available, don't try to handle
    if (!alchemyApiKey && !zkevmRpcUrl) {
      logger.debug('[getCurrentBlockNumberAction] No API keys available');
      return false;
    }

    const content = message.content?.text?.toLowerCase() || '';

    // Simple keyword matching - much more permissive
    const blockKeywords = ['block', 'polygon', 'zkevm', 'zkEVM', 'current', 'latest', 'number'];

    // Check if message contains relevant keywords
    const hasBlockKeyword = blockKeywords.some((keyword) =>
      content.includes(keyword.toLowerCase())
    );

    // Also check for specific patterns
    const hasBlockPattern =
      /block.*number|current.*block|latest.*block|polygon.*block|zkevm.*block/i.test(content);

    // Much simpler validation - if it mentions blocks or zkEVM, try to handle it
    const shouldHandle = hasBlockKeyword || hasBlockPattern;

    if (shouldHandle) {
      logger.debug('[getCurrentBlockNumberAction] Validation passed for message:', content);
    }

    return shouldHandle;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getCurrentBlockNumberAction] Handler called!');

    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

    if (!alchemyApiKey && !zkevmRpcUrl) {
      throw new Error('ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.');
    }

    let blockNumber: number | null = null;
    let methodUsed: 'alchemy' | 'rpc' | null = null;
    let errorMessages: string[] = [];

    // 1. Attempt to use Alchemy API
    if (alchemyApiKey) {
      try {
        logger.info('[getCurrentBlockNumberAction] Attempting to use Alchemy API');
        const zkevmAlchemyUrl =
          runtime.getSetting('ZKEVM_ALCHEMY_URL') ||
          'https://polygonzkevm-mainnet.g.alchemy.com/v2';
        const alchemyUrl = `${zkevmAlchemyUrl}/${alchemyApiKey}`;
        const options = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'eth_blockNumber',
            params: [],
            id: 1,
          }),
        };

        const response = await fetch(alchemyUrl, options);
        if (!response.ok) {
          throw new Error(`Alchemy API returned status ${response.status}: ${response.statusText}`);
        }
        const data = (await response.json()) as { error?: { message: string }; result?: string };

        if (data?.error) {
          throw new Error(`Alchemy API returned error: ${data?.error?.message}`);
        }

        if (data?.result) {
          blockNumber = parseInt(data?.result, 16);
          methodUsed = 'alchemy';
          logger.info(`[getCurrentBlockNumberAction] Block number from Alchemy: ${blockNumber}`);
        } else {
          logger.error('Alchemy API did not return a result.');
          throw new Error('Alchemy API did not return a result.');
        }
      } catch (error) {
        logger.error('Error using Alchemy API:', error);
        errorMessages.push(
          `Alchemy API failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // 2. Fallback to JSON-RPC if Alchemy failed or not configured
    if (blockNumber === null && zkevmRpcUrl) {
      logger.info('[getCurrentBlockNumberAction] Falling back to JSON-RPC');
      try {
        const provider = new JsonRpcProvider(zkevmRpcUrl);
        const latestBlock = await provider.getBlockNumber();

        blockNumber = latestBlock;
        methodUsed = 'rpc';
        logger.info(`[getCurrentBlockNumberAction] Block number from RPC: ${blockNumber}`);
      } catch (error) {
        logger.error('Error using JSON-RPC fallback:', error);
        errorMessages.push(
          `JSON-RPC fallback failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Handle result and errors
    if (blockNumber !== null) {
      const responseContent: Content = {
        text: `📊 The current Polygon zkEVM block number is **${blockNumber.toLocaleString()}** (retrieved via ${methodUsed}).`,
        actions: ['POLYGON_GET_CURRENT_BLOCK_NUMBER_ZKEVM'],
        data: {
          blockNumber,
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
      const errorMessage = `❌ Failed to retrieve Polygon zkEVM block number using both Alchemy and RPC. Errors: ${errorMessages.join('; ')}`;
      logger.error(errorMessage);

      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYGON_GET_CURRENT_BLOCK_NUMBER_ZKEVM'],
        data: { error: errorMessage, errors: errorMessages },
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
          text: 'What is the current block number on Polygon zkEVM?',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll get the current block number for Polygon zkEVM.",
          action: 'POLYGON_GET_CURRENT_BLOCK_NUMBER_ZKEVM',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Show me the latest zkEVM block on Polygon',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me fetch the latest block number for you on Polygon zkEVM.',
          action: 'POLYGON_GET_CURRENT_BLOCK_NUMBER_ZKEVM',
        },
      },
    ],
  ],
};
