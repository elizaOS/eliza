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
import { JsonRpcProvider, isAddress, getAddress } from 'ethers';
import { estimateGasTemplate } from '../templates';
import { callLLMWithTimeout } from '../utils/llmHelpers';

/**
 * Validate and normalize an Ethereum address
 */
function validateAndNormalizeAddress(address: string): string {
  if (!address) {
    throw new Error('Address is required');
  }

  // Remove any whitespace
  const cleanAddress = address.trim();

  // Check if it's a valid address format
  if (!isAddress(cleanAddress)) {
    throw new Error(
      `Invalid address format: ${cleanAddress}. Please provide a valid Ethereum address starting with 0x.`
    );
  }

  // Return the checksummed address
  try {
    return getAddress(cleanAddress);
  } catch (error) {
    throw new Error(
      `Invalid address checksum: ${cleanAddress}. Please use the correct capitalization or provide the address in all lowercase.`
    );
  }
}

/**
 * Estimate gas action for Polygon zkEVM
 * Estimates gas required for a transaction
 */
export const estimateGasAction: Action = {
  name: 'POLYGON_ZKEVM_ESTIMATE_GAS',
  similes: ['ESTIMATE_GAS', 'GAS_ESTIMATE', 'GAS_COST', 'TRANSACTION_COST'].map(
    (s) => `POLYGON_ZKEVM_${s}`
  ),
  description: 'Estimates the gas required for a transaction on Polygon zkEVM.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

    if (!alchemyApiKey && !zkevmRpcUrl) {
      return false;
    }

    // Check if the message is about gas estimation
    const messageText = message.content.text?.toLowerCase() || '';
    const gasEstimationKeywords = [
      'estimate gas',
      'gas estimate',
      'gas cost',
      'transaction cost',
      'how much gas',
      'gas fee',
      'estimate fee',
      'cost to send',
      'transaction fee',
    ];

    const hasGasKeywords = gasEstimationKeywords.some((keyword) => messageText.includes(keyword));

    // Also check for transaction-like patterns (address + value/action)
    const hasAddress = /0x[a-fA-F0-9]{40}/.test(messageText);
    const hasValue = /\d+(?:\.\d+)?\s*eth/i.test(messageText) || messageText.includes('send');

    logger.debug('[estimateGasAction] Validation check:', {
      hasGasKeywords,
      hasAddress,
      hasValue,
      messageText: messageText.substring(0, 100),
    });

    return hasGasKeywords || (hasAddress && hasValue);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    try {
      logger.info('[estimateGasAction] Handler called!');

      const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
      const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

      if (!alchemyApiKey && !zkevmRpcUrl) {
        const errorMessage = 'ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.';
        logger.error(`[estimateGasAction] Configuration error: ${errorMessage}`);
        const errorContent: Content = {
          text: errorMessage,
          actions: ['POLYGON_ESTIMATE_GAS_ZKEVM'],
          data: { error: errorMessage },
        };

        if (callback) {
          await callback(errorContent);
        }
        throw new Error(errorMessage);
      }

      let gasInput: any | null = null;

      // Extract gas estimation parameters using LLM with OBJECT_LARGE model
      try {
        gasInput = await callLLMWithTimeout<{
          to?: string;
          from?: string;
          value?: string;
          data?: string;
          error?: string;
        }>(runtime, state, estimateGasTemplate, 'estimateGasAction');

        if (gasInput?.error) {
          logger.error('[estimateGasAction] LLM returned an error:', gasInput?.error);
          throw new Error(gasInput?.error);
        }

        // Validate that we got at least a 'to' address
        if (!gasInput?.to) {
          throw new Error(
            'Could not extract transaction parameters. Please specify at least a recipient address.'
          );
        }
      } catch (error) {
        logger.error(
          '[estimateGasAction] OBJECT_LARGE model failed',
          error instanceof Error ? error : undefined
        );
        throw new Error(
          `[estimateGasAction] Failed to extract gas estimation parameters from input: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Setup provider - prefer Alchemy, fallback to RPC
      let provider: JsonRpcProvider;
      const zkevmAlchemyUrl =
        runtime.getSetting('ZKEVM_ALCHEMY_URL') || 'https://polygonzkevm-mainnet.g.alchemy.com/v2';

      if (alchemyApiKey) {
        provider = new JsonRpcProvider(`${zkevmAlchemyUrl}/${alchemyApiKey}`);
        logger.info('[estimateGasAction] Using Alchemy provider');
      } else {
        provider = new JsonRpcProvider(zkevmRpcUrl);
        logger.info('[estimateGasAction] Using RPC provider:', zkevmRpcUrl);
      }

      // Build transaction object from extracted parameters with validation
      logger.info('[estimateGasAction] Building transaction object...');
      const transaction: any = {};

      if (gasInput.to) {
        try {
          transaction.to = validateAndNormalizeAddress(gasInput.to);
        } catch (error) {
          throw new Error(
            `Invalid 'to' address: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      if (gasInput.from) {
        try {
          transaction.from = validateAndNormalizeAddress(gasInput.from);
        } catch (error) {
          throw new Error(
            `Invalid 'from' address: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      if (gasInput.value) {
        const ethValue = parseFloat(gasInput.value);
        if (isNaN(ethValue) || ethValue < 0) {
          throw new Error(
            `Invalid value: ${gasInput.value}. Please provide a valid positive number.`
          );
        }
        transaction.value = '0x' + BigInt(Math.floor(ethValue * 1e18)).toString(16);
      }

      if (gasInput.data) {
        // Basic validation for hex data
        if (gasInput.data && !gasInput.data.startsWith('0x')) {
          transaction.data = '0x' + gasInput.data;
        } else {
          transaction.data = gasInput.data;
        }
      }

      // Estimate gas
      logger.info('[estimateGasAction] Starting gas estimation with transaction:', transaction);
      const gasEstimate = await provider.estimateGas(transaction);
      logger.info('[estimateGasAction] Gas estimation completed:', gasEstimate.toString());

      logger.info('[estimateGasAction] Getting gas price...');
      const gasPrice = await provider.send('eth_gasPrice', []);
      logger.info('[estimateGasAction] Gas price retrieved:', gasPrice);

      // Calculate costs
      const gasCostWei = gasEstimate * BigInt(gasPrice);
      const gasCostEth = Number(gasCostWei) / 1e18;
      const gasPriceGwei = Number(BigInt(gasPrice)) / 1e9;

      const responseText = `⛽ **Gas Estimation for Polygon zkEVM**

**Transaction Details:**
- To: ${transaction.to || 'N/A'}
- From: ${transaction.from || 'N/A'}
- Value: ${gasInput.value ? `${gasInput.value} ETH` : '0 ETH'}
- Data: ${transaction.data ? `${transaction.data.slice(0, 20)}...` : 'None'}

**Gas Estimation:**
- Estimated Gas: ${gasEstimate.toString()} units
- Gas Price: ${gasPriceGwei.toFixed(2)} Gwei
- Total Cost: ${gasCostEth.toFixed(6)} ETH (~$${(gasCostEth * 2000).toFixed(2)} USD)

**Network:** Polygon zkEVM`;

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYGON_ESTIMATE_GAS_ZKEVM'],
        data: {
          gasEstimate: gasEstimate.toString(),
          gasPrice: gasPrice.toString(),
          gasCostWei: gasCostWei.toString(),
          gasCostEth,
          gasPriceGwei,
          transaction,
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      const errorMessage = `Failed to estimate gas: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMessage);

      const errorContent: Content = {
        text: `❌ ${errorMessage}`,
        actions: ['POLYGON_ESTIMATE_GAS_ZKEVM'],
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
          text: 'Estimate gas cost to send 0.5 ETH to 0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6 on Polygon zkEVM',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll estimate the gas cost for that transaction on Polygon zkEVM.",
          action: 'POLYGON_ESTIMATE_GAS_ZKEVM',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'how much gas to interact with contract 0x123... on Polygon zkEVM?',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me estimate the gas for that contract interaction on Polygon zkEVM.',
          action: 'POLYGON_ESTIMATE_GAS_ZKEVM',
        },
      },
    ],
  ],
};
