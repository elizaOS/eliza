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
import { getTransactionCountTemplate } from '../templates';
import { callLLMWithTimeout } from '../utils/llmHelpers';

/**
 * Get transaction count action for Polygon zkEVM
 * Retrieves the transaction count (nonce) for a specific address
 */
export const getTransactionCountAction: Action = {
  name: 'POLYGON_ZKEVM_GET_TRANSACTION_COUNT',
  similes: ['GET_NONCE', 'TRANSACTION_COUNT', 'NONCE', 'TX_COUNT'].map((s) => `POLYGON_ZKEVM_${s}`),
  description: 'Gets the transaction count (nonce) for a given address on Polygon zkEVM.',

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
    logger.info('[getTransactionCountAction] Handler called!');

    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

    if (!alchemyApiKey && !zkevmRpcUrl) {
      const errorMessage = 'ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.';
      logger.error(`[getTransactionCountAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYGON_GET_TRANSACTION_COUNT_ZKEVM'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    let addressInput: any | null = null;

    // Extract address using LLM with OBJECT_LARGE model
    try {
      addressInput = await callLLMWithTimeout<{ address: string }>(
        runtime,
        state,
        getTransactionCountTemplate,
        'getTransactionCountAction'
      );

      if (addressInput?.error) {
        logger.error('[getTransactionCountAction] LLM returned an error:', addressInput?.error);
        throw new Error(addressInput?.error);
      }

      if (!addressInput?.address || typeof addressInput.address !== 'string') {
        throw new Error('Invalid address received from LLM.');
      }
    } catch (error) {
      logger.debug(
        '[getTransactionCountAction] OBJECT_LARGE model failed',
        error instanceof Error ? error : undefined
      );
      throw new Error(
        `[getTransactionCountAction] Failed to extract address from input: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const address = addressInput.address;

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

    // Get transaction count for both latest and pending
    const [latestCount, pendingCount] = await Promise.all([
      provider.getTransactionCount(address, 'latest'),
      provider.getTransactionCount(address, 'pending'),
    ]);

    let responseText = `📊 **Transaction Count (Polygon zkEVM)**

**Address:** \`${address}\`
**Latest:** ${latestCount} transactions
**Pending:** ${pendingCount} transactions
**Method:** ${methodUsed}`;

    if (pendingCount > latestCount) {
      const pendingTxs = pendingCount - latestCount;
      responseText += `\n**Pending Transactions:** ${pendingTxs}`;
    }

    responseText += `\n\n💡 **Next Nonce:** ${pendingCount}`;

    const responseContent: Content = {
      text: responseText,
      actions: ['POLYGON_GET_TRANSACTION_COUNT_ZKEVM'],
      data: {
        address,
        latestCount,
        pendingCount,
        nextNonce: pendingCount,
        network: 'polygon-zkevm',
        method: methodUsed,
      },
    };

    if (callback) {
      await callback(responseContent);
    }

    return responseContent;
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'What is the transaction count for 0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6 on Polygon zkEVM?',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll get the transaction count for that address on Polygon zkEVM.",
          action: 'POLYGON_GET_TRANSACTION_COUNT_ZKEVM',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Get nonce for 0x1234567890123456789012345678901234567890 on Polygon zkEVM',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me get the nonce for that address on Polygon zkEVM.',
          action: 'POLYGON_GET_TRANSACTION_COUNT_ZKEVM',
        },
      },
    ],
  ],
};
