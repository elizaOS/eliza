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
import { getBalanceTemplate } from '../templates';
import { callLLMWithTimeout } from '../utils/llmHelpers';

/**
 * Get balance action for Polygon zkEVM
 * Retrieves the balance of a specific address
 */
export const getBalanceAction: Action = {
  name: 'POLYGON_ZKEVM_GET_BALANCE',
  similes: ['CHECK_BALANCE', 'BALANCE', 'GET_ETH_BALANCE', 'WALLET_BALANCE'].map(
    (s) => `POLYGON_ZKEVM_${s}`
  ),
  description: 'Gets the balance of a given address on Polygon zkEVM.',

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
    logger.info('[getBalanceAction] Handler called!');

    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

    if (!alchemyApiKey && !zkevmRpcUrl) {
      const errorMessage = 'ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.';
      logger.error(`[getBalanceAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYGON_GET_BALANCE_ZKEVM'],
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
        getBalanceTemplate,
        'getBalanceAction'
      );

      if (addressInput?.error) {
        logger.error('[getBalanceAction] LLM returned an error:', addressInput?.error);
        throw new Error(addressInput?.error);
      }

      if (!addressInput?.address || typeof addressInput.address !== 'string') {
        throw new Error('Invalid address received from LLM.');
      }
    } catch (error) {
      logger.debug(
        '[getBalanceAction] OBJECT_LARGE model failed',
        error instanceof Error ? error : undefined
      );
      throw new Error(
        `[getBalanceAction] Failed to extract address from input: ${error instanceof Error ? error.message : String(error)}`
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

    // Get balance
    const balance = await provider.getBalance(address);
    const balanceInEth = Number(balance) / 1e18;

    const responseContent: Content = {
      text: `💰 **Balance for ${address}**

**Balance:** ${balanceInEth.toFixed(6)} ETH (${balance.toString()} wei)
**Network:** Polygon zkEVM
**Method:** ${methodUsed}`,
      actions: ['POLYGON_GET_BALANCE_ZKEVM'],
      data: {
        address,
        balance: balance.toString(),
        balanceInEth,
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
          text: 'What is the balance of 0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6 on Polygon zkEVM?',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll check the balance for that address on Polygon zkEVM.",
          action: 'POLYGON_GET_BALANCE_ZKEVM',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Check balance for 0x1234567890123456789012345678901234567890 on Polygon zkEVM',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me get the balance for that address on Polygon zkEVM.',
          action: 'POLYGON_GET_BALANCE_ZKEVM',
        },
      },
    ],
  ],
};
