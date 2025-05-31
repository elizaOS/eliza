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
import { JsonRpcProvider, isAddress, getAddress, parseUnits, formatUnits } from 'ethers';
import { estimateTransactionFeeTemplate } from '../templates';
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
 * Estimate transaction fee action for Polygon zkEVM
 * Estimates gas limit and total fee for a provided transaction payload
 */
export const estimateTransactionFeeAction: Action = {
  name: 'ESTIMATE_TRANSACTION_FEE',
  similes: [
    'ESTIMATE_FEE',
    'TRANSACTION_FEE',
    'FEE_ESTIMATE',
    'CALCULATE_FEE',
    'GAS_ESTIMATE',
    'TRANSACTION_COST',
  ],
  description: 'Estimate gas limit and total fee for a transaction on Polygon zkEVM',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

    if (!alchemyApiKey && !zkevmRpcUrl) {
      return false;
    }

    // Check if the message is about transaction fee estimation
    const messageText = message.content.text?.toLowerCase() || '';
    const feeEstimationKeywords = [
      'estimate fee',
      'transaction fee',
      'estimate cost',
      'calculate fee',
      'gas limit',
      'total fee',
      'fee estimate',
      'cost estimate',
      'how much will it cost',
      'transaction cost',
      'estimate gas',
    ];

    const hasFeeKeywords = feeEstimationKeywords.some((keyword) => messageText.includes(keyword));

    // Also check for transaction-like patterns (address + value/action)
    const hasAddress = /0x[a-fA-F0-9]{40}/.test(messageText);
    const hasValue = /\d+(?:\.\d+)?\s*eth/i.test(messageText) || messageText.includes('send');

    logger.debug('[estimateTransactionFeeAction] Validation check:', {
      hasFeeKeywords,
      hasAddress,
      hasValue,
      messageText: messageText.substring(0, 100),
    });

    return hasFeeKeywords || (hasAddress && hasValue);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    try {
      logger.info('[estimateTransactionFeeAction] Handler called!');

      const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
      const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

      if (!alchemyApiKey && !zkevmRpcUrl) {
        const errorMessage = 'ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.';
        logger.error(`[estimateTransactionFeeAction] Configuration error: ${errorMessage}`);
        const errorContent: Content = {
          text: errorMessage,
          actions: ['ESTIMATE_TRANSACTION_FEE'],
          data: { error: errorMessage },
        };

        if (callback) {
          await callback(errorContent);
        }
        throw new Error(errorMessage);
      }

      let transactionInput: any | null = null;

      // Extract transaction parameters using LLM with OBJECT_LARGE model
      try {
        transactionInput = await callLLMWithTimeout<{
          to?: string;
          from?: string;
          value?: string;
          data?: string;
          priorityFee?: string;
          gasPrice?: string;
          rawTransaction?: string;
          error?: string;
        }>(runtime, state, estimateTransactionFeeTemplate, 'estimateTransactionFeeAction');

        if (transactionInput?.error) {
          logger.error(
            '[estimateTransactionFeeAction] LLM returned an error:',
            transactionInput?.error
          );
          throw new Error(transactionInput?.error);
        }

        // Handle raw transaction if provided
        if (transactionInput?.rawTransaction && !transactionInput?.to) {
          logger.info('[estimateTransactionFeeAction] Processing raw transaction...');
          // For raw transactions, we'll need the 'to' field at minimum
          // This is a simplified approach - in a real implementation you might want to parse the raw tx
          throw new Error(
            'Raw transaction parsing not yet implemented. Please provide transaction parameters (to, value, data).'
          );
        }

        // Validate that we got at least a 'to' address
        if (!transactionInput?.to) {
          throw new Error(
            'Could not extract transaction parameters. Please specify at least a recipient address.'
          );
        }
      } catch (error) {
        logger.error(
          '[estimateTransactionFeeAction] OBJECT_LARGE model failed',
          error instanceof Error ? error : undefined
        );
        throw new Error(
          `[estimateTransactionFeeAction] Failed to extract transaction parameters from input: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Setup provider - prefer Alchemy, fallback to RPC
      let provider: JsonRpcProvider;
      const zkevmAlchemyUrl =
        runtime.getSetting('ZKEVM_ALCHEMY_URL') || 'https://polygonzkevm-mainnet.g.alchemy.com/v2';

      if (alchemyApiKey) {
        provider = new JsonRpcProvider(`${zkevmAlchemyUrl}/${alchemyApiKey}`);
        logger.info('[estimateTransactionFeeAction] Using Alchemy provider');
      } else {
        provider = new JsonRpcProvider(zkevmRpcUrl);
        logger.info('[estimateTransactionFeeAction] Using RPC provider:', zkevmRpcUrl);
      }

      // Build transaction object from extracted parameters with validation
      logger.info('[estimateTransactionFeeAction] Building transaction object...');
      const transaction: any = {};

      if (transactionInput.to) {
        try {
          transaction.to = validateAndNormalizeAddress(transactionInput.to);
        } catch (error) {
          throw new Error(
            `Invalid 'to' address: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      if (transactionInput.from) {
        try {
          transaction.from = validateAndNormalizeAddress(transactionInput.from);
        } catch (error) {
          throw new Error(
            `Invalid 'from' address: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      if (transactionInput.value) {
        const ethValue = parseFloat(transactionInput.value);
        if (isNaN(ethValue) || ethValue < 0) {
          throw new Error(
            `Invalid value: ${transactionInput.value}. Please provide a valid positive number.`
          );
        }
        transaction.value = '0x' + BigInt(Math.floor(ethValue * 1e18)).toString(16);
      }

      if (transactionInput.data) {
        // Basic validation for hex data
        if (transactionInput.data && !transactionInput.data.startsWith('0x')) {
          transaction.data = '0x' + transactionInput.data;
        } else {
          transaction.data = transactionInput.data;
        }
      }

      // Estimate gas limit
      logger.info(
        '[estimateTransactionFeeAction] Starting gas estimation with transaction:',
        transaction
      );
      const gasLimit = await provider.estimateGas(transaction);
      logger.info('[estimateTransactionFeeAction] Gas estimation completed:', gasLimit.toString());

      // Get gas price - use priority fee if provided, otherwise get current gas price
      let gasPrice: bigint;

      if (transactionInput.priorityFee) {
        try {
          gasPrice = parseUnits(transactionInput.priorityFee, 'gwei');
          logger.info(
            '[estimateTransactionFeeAction] Using provided priority fee:',
            gasPrice.toString()
          );
        } catch (error) {
          logger.warn(
            '[estimateTransactionFeeAction] Invalid priority fee format, falling back to network gas price'
          );
          const gasPriceHex = await provider.send('eth_gasPrice', []);
          gasPrice = BigInt(gasPriceHex);
        }
      } else if (transactionInput.gasPrice) {
        try {
          gasPrice = parseUnits(transactionInput.gasPrice, 'gwei');
          logger.info(
            '[estimateTransactionFeeAction] Using provided gas price:',
            gasPrice.toString()
          );
        } catch (error) {
          logger.warn(
            '[estimateTransactionFeeAction] Invalid gas price format, falling back to network gas price'
          );
          const gasPriceHex = await provider.send('eth_gasPrice', []);
          gasPrice = BigInt(gasPriceHex);
        }
      } else {
        logger.info('[estimateTransactionFeeAction] Getting current gas price...');
        const gasPriceHex = await provider.send('eth_gasPrice', []);
        gasPrice = BigInt(gasPriceHex);
        logger.info('[estimateTransactionFeeAction] Gas price retrieved:', gasPrice.toString());
      }

      // Calculate total fee
      const totalFeeWei = gasLimit * gasPrice;
      const totalFeeEth = formatUnits(totalFeeWei, 'ether');
      const gasPriceGwei = formatUnits(gasPrice, 'gwei');

      // Prepare response data in the required format
      const responseData = {
        gasLimit: gasLimit.toString(),
        fee: totalFeeWei.toString(), // fee in wei as string
        gasPrice: gasPrice.toString(),
        gasPriceGwei,
        totalFeeEth,
        transaction,
        network: 'polygon-zkevm',
      };

      const responseText = `💰 **Transaction Fee Estimate (Polygon zkEVM)**

**Transaction Details:**
- To: ${transaction.to || 'N/A'}
- From: ${transaction.from || 'N/A'}
- Value: ${transactionInput.value ? `${transactionInput.value} ETH` : '0 ETH'}
- Data: ${transaction.data ? `${transaction.data.slice(0, 20)}...` : 'None'}

**Fee Estimation:**
- Gas Limit: ${responseData.gasLimit} units
- Gas Price: ${gasPriceGwei} Gwei
- Total Fee: ${totalFeeEth} ETH (~$${(parseFloat(totalFeeEth) * 2000).toFixed(2)} USD)

**Network:** Polygon zkEVM
${transactionInput.priorityFee ? `\n**Note:** Used custom priority fee of ${transactionInput.priorityFee} Gwei` : ''}`;

      const responseContent: Content = {
        text: responseText,
        actions: ['ESTIMATE_TRANSACTION_FEE'],
        data: responseData,
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      const errorMessage = `Failed to estimate transaction fee: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMessage);

      const errorContent: Content = {
        text: `❌ ${errorMessage}`,
        actions: ['ESTIMATE_TRANSACTION_FEE'],
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
          text: 'Estimate the transaction fee for sending 0.1 ETH to 0x742d35Cc6634C0532925A3B8D4C9dB96C4B4d8B6',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll estimate the transaction fee for that transfer on Polygon zkEVM.",
          actions: ['ESTIMATE_TRANSACTION_FEE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Calculate the fee for calling a contract at 0x1234567890123456789012345678901234567890 with priority fee of 2 gwei',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me calculate the transaction fee for that contract call with your specified priority fee.',
          actions: ['ESTIMATE_TRANSACTION_FEE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'How much will it cost to deploy a smart contract?',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'I can estimate the transaction fee for contract deployment. Please provide the contract bytecode or transaction details.',
          actions: ['ESTIMATE_TRANSACTION_FEE'],
        },
      },
    ],
  ],
};
