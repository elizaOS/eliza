import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  type Content,
  logger,
  ModelType,
  composePromptFromState,
} from '@elizaos/core';
import { z } from 'zod';
import { JsonRpcProvider } from 'ethers';
import { blockDetailsByHashTemplate } from '../templates';
import { callLLMWithTimeout } from '../utils/llmHelpers';

export const getBlockDetailsByHashAction: Action = {
  name: 'POLYGON_ZKEVM_GET_BLOCK_DETAILS_BY_HASH',
  similes: ['GET_BLOCK_BY_HASH', 'SHOW_BLOCK_DETAILS_BY_HASH'].map((s) => `POLYGON_ZKEVM_${s}`),
  description: 'Gets block details for a given hash on Polygon zkEVM.',

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
    logger.info('[getBlockDetailsByHashAction] Handler called!');

    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

    if (!alchemyApiKey && !zkevmRpcUrl) {
      const errorMessage = 'ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.';
      logger.error(`[getBlockDetailsByHashAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYGON_ZKEVM_GET_BLOCK_DETAILS_BY_HASH'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    let blockDetails: any | null = null;
    let methodUsed: 'alchemy' | 'rpc' | null = null;
    let errorMessages: string[] = [];
    let blockHashInput: any | null = null;

    // First try using OBJECT_LARGE model type for structured output
    try {
      blockHashInput = await callLLMWithTimeout<{ blockHash: string }>(
        runtime,
        state,
        blockDetailsByHashTemplate,
        'getBlockDetailsByHashAction'
      );

      // Check if the model returned an error field
      if (blockHashInput?.error) {
        logger.error('[getBlockDetailsByHashAction] LLM returned an error:', blockHashInput?.error);
        throw new Error(blockHashInput?.error);
      }

      // Validate blockHashInput format (basic check for non-empty string)
      if (!blockHashInput?.blockHash || typeof blockHashInput.blockHash !== 'string') {
        throw new Error('Invalid block hash received from LLM.');
      }
    } catch (error) {
      logger.debug(
        '[getBlockDetailsByHashAction] OBJECT_LARGE model failed',
        error instanceof Error ? error : undefined
      );
      throw new Error(
        `[getBlockDetailsByHashAction] Failed to extract block hash from input: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // 1. Attempt to use Alchemy API (using eth_getBlockByHash method)
    if (alchemyApiKey) {
      try {
        logger.info(
          `[getBlockDetailsByHashAction] Attempting to use Alchemy API for block hash ${blockHashInput.blockHash}`
        );
        const alchemyUrl = `${zkevmRpcUrl}/${alchemyApiKey}`;
        const options = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'eth_getBlockByHash',
            params: [blockHashInput.blockHash, true], // true for full transaction details
            id: 1,
          }),
        };

        const response = await fetch(alchemyUrl, options);
        if (!response.ok) {
          throw new Error(`Alchemy API returned status ${response.status}: ${response.statusText}`);
        }
        const data = (await response.json()) as { error?: { message: string }; result?: any };

        if (data?.error) {
          throw new Error(`Alchemy API returned error: ${data?.error?.message}`);
        }

        if (data?.result) {
          blockDetails = data?.result;
          methodUsed = 'alchemy';
          logger.info(
            `[getBlockDetailsByHashAction] Block details from Alchemy for block hash ${blockHashInput.blockHash}`
          );
        } else {
          logger.warn(
            `[getBlockDetailsByHashAction] Alchemy API returned no result for block hash ${blockHashInput.blockHash}.`
          );
        }
      } catch (error) {
        logger.error(`Error using Alchemy API for block hash ${blockHashInput.blockHash}:`, error);
        errorMessages.push(
          `Alchemy API failed: ${error instanceof Error ? error.message : String(error)}`
        );
        // Continue to fallback
      }
    }

    // 2. Fallback to JSON-RPC if Alchemy failed or not configured
    if (blockDetails === null && zkevmRpcUrl) {
      logger.info(
        `[getBlockDetailsByHashAction] Falling back to JSON-RPC for block hash ${blockHashInput.blockHash}`
      );
      try {
        const provider = new JsonRpcProvider(zkevmRpcUrl);
        const block = await provider.getBlock(blockHashInput.blockHash, true); // true for full transaction details

        if (block) {
          blockDetails = block.toJSON();
          methodUsed = 'rpc';
          logger.info(
            `[getBlockDetailsByHashAction] Block details from RPC for block hash ${blockHashInput.blockHash}`
          );
        } else {
          logger.warn(
            `[getBlockDetailsByHashAction] RPC returned no block for hash ${blockHashInput.blockHash}.`
          );
        }
      } catch (error) {
        logger.error(
          `Error using JSON-RPC fallback for block hash ${blockHashInput.blockHash}:`,
          error
        );
        errorMessages.push(
          `JSON-RPC fallback failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Handle result and errors
    if (blockDetails !== null) {
      // Attempt to extract zkEVM specific fields if they exist
      const zkevmFields = {
        zkProverVersion: blockDetails.zkProverVersion,
        batchIndex: blockDetails.batchIndex,
      };

      const responseContent: Content = {
        text: `Here are the details for Polygon zkEVM block ${blockHashInput.blockHash} (via ${methodUsed}):
\`\`\`json
${JSON.stringify(blockDetails, null, 2)}
\`\`\`
ZK-specific fields: ${JSON.stringify(zkevmFields, null, 2)}`,
        actions: ['POLYGON_ZKEVM_GET_BLOCK_DETAILS_BY_HASH'],
        data: {
          block: blockDetails,
          zkevmFields: zkevmFields,
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
      // Both methods failed or block not found
      const errorMessage = `Failed to retrieve details for Polygon zkEVM block hash ${blockHashInput.blockHash} using both Alchemy and RPC. Errors: ${errorMessages.join('; ')}. It's possible the block hash is invalid or the block does not exist yet.`;
      logger.error(errorMessage);

      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYGON_ZKEVM_GET_BLOCK_DETAILS_BY_HASH'],
        data: { error: errorMessage, errors: errorMessages, blockHashInput },
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
          text: 'get polygon zkevm block details for hash 0xd5f1812548be429cbdc6376b29611fc49e06f1359758c4ceaaa3b393e2239f9c',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Here are the details for Polygon zkEVM block 0xd5f1812548be429cbdc6376b29611fc49e06f1359758c4ceaaa3b393e2239f9c (via alchemy):\n```json\n{\n  "number": 12345,\n  "hash": "0xd5f1812548be429cbdc6376b29611fc49e06f1359758c4ceaaa3b393e2239f9c",\n  "parentHash": "0x...",\n  "timestamp": 1234567890,\n  "transactions": []\n}\n```\nZK-specific fields: {\n  "zkProverVersion": "1.0.0",\n  "batchIndex": 123\n}',
          action: 'POLYGON_ZKEVM_GET_BLOCK_DETAILS_BY_HASH',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'show block details for hash 0xabcdef... on Polygon zkEVM',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Here are the details for Polygon zkEVM block 0xabcdef... (via rpc):\n```json\n{\n  "number": 12346,\n  "hash": "0xabcdef...",\n  "parentHash": "0x...",\n  "timestamp": 1234567891,\n  "transactions": []\n}\n```\nZK-specific fields: {\n  "zkProverVersion": "1.0.0",\n  "batchIndex": 124\n}',
          action: 'POLYGON_ZKEVM_GET_BLOCK_DETAILS_BY_HASH',
        },
      },
    ],
  ],
};
