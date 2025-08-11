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
import { getTransactionDetailsTemplate } from '../templates';
import { JsonRpcProvider } from 'ethers';
import { callLLMWithTimeout } from '../utils/llmHelpers';

/**
 * Get transaction details and receipt action for Polygon zkEVM
 * Retrieves both transaction data and receipt for a given transaction hash
 */
export const getTransactionDetailsAction: Action = {
  name: 'POLYGON_ZKEVM_GET_TRANSACTION_DETAILS',
  similes: [
    'GET_TX_DETAILS',
    'TRANSACTION_DETAILS',
    'TX_INFO',
    'GET_TRANSACTION_INFO',
    'TRANSACTION_DATA',
    'TX_RECEIPT',
    'GET_TX_DATA',
  ].map((s) => `POLYGON_ZKEVM_${s}`),
  description:
    'Get comprehensive transaction details including receipt data for a Polygon zkEVM transaction hash',

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
    try {
      logger.info('🔍 Handling GET_TRANSACTION_DETAILS action');

      const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
      const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

      if (!alchemyApiKey && !zkevmRpcUrl) {
        const errorMessage = 'ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.';
        logger.error(`[getTransactionDetailsAction] Configuration error: ${errorMessage}`);
        const errorContent: Content = {
          text: errorMessage,
          actions: ['POLYGON_GET_TRANSACTION_DETAILS_ZKEVM'],
          data: { error: errorMessage },
        };

        if (callback) {
          await callback(errorContent);
        }
        throw new Error(errorMessage);
      }

      let hashInput: any | null = null;

      // Extract transaction hash using LLM with OBJECT_LARGE model
      try {
        hashInput = await callLLMWithTimeout<{ transactionHash: string; error?: string }>(
          runtime,
          state,
          getTransactionDetailsTemplate,
          'getTransactionDetailsAction'
        );

        if (hashInput?.error) {
          logger.error('[getTransactionDetailsAction] LLM returned an error:', hashInput?.error);
          throw new Error(hashInput?.error);
        }

        if (!hashInput?.transactionHash || typeof hashInput.transactionHash !== 'string') {
          throw new Error('Invalid transaction hash received from LLM.');
        }
      } catch (error) {
        logger.error(
          '[getTransactionDetailsAction] OBJECT_LARGE model failed',
          error instanceof Error ? error : undefined
        );
        throw new Error(
          `[getTransactionDetailsAction] Failed to extract transaction hash from input: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      const txHash = hashInput.transactionHash;
      logger.info(`📋 Getting transaction details for hash: ${txHash}`);

      // Setup provider - prefer Alchemy, fallback to RPC
      let provider: JsonRpcProvider;
      let methodUsed: 'alchemy' | 'rpc' = 'rpc';
      const zkevmAlchemyUrl =
        runtime.getSetting('ZKEVM_ALCHEMY_URL') || 'https://polygonzkevm-mainnet.g.alchemy.com/v2';

      if (alchemyApiKey) {
        provider = new JsonRpcProvider(`${zkevmAlchemyUrl}/${alchemyApiKey}`);
        methodUsed = 'alchemy';
        logger.info('🔗 Using Alchemy API for transaction details');
      } else {
        provider = new JsonRpcProvider(zkevmRpcUrl);
        logger.info('🔗 Using direct RPC for transaction details');
      }

      let transactionData: any = null;
      let receiptData: any = null;
      let errorMessages: string[] = [];

      // Get transaction data
      try {
        logger.info('📥 Fetching transaction data...');
        transactionData = await provider.getTransaction(txHash);

        if (!transactionData) {
          throw new Error('Transaction not found');
        }

        logger.info('✅ Transaction data retrieved successfully');
      } catch (error) {
        const errorMsg = `Failed to get transaction data: ${error instanceof Error ? error.message : String(error)}`;
        logger.error(errorMsg);
        errorMessages.push(errorMsg);
      }

      // Get transaction receipt
      try {
        logger.info('📄 Fetching transaction receipt...');
        receiptData = await provider.getTransactionReceipt(txHash);

        if (!receiptData) {
          throw new Error('Transaction receipt not found');
        }

        logger.info('✅ Transaction receipt retrieved successfully');
      } catch (error) {
        const errorMsg = `Failed to get transaction receipt: ${error instanceof Error ? error.message : String(error)}`;
        logger.error(errorMsg);
        errorMessages.push(errorMsg);
      }

      // If both failed, try fallback method if using Alchemy
      if (!transactionData && !receiptData && methodUsed === 'alchemy') {
        logger.info('🔄 Attempting fallback to direct RPC...');
        try {
          const fallbackProvider = new JsonRpcProvider(zkevmRpcUrl || 'https://zkevm-rpc.com');

          if (!transactionData) {
            transactionData = await fallbackProvider.getTransaction(txHash);
          }

          if (!receiptData) {
            receiptData = await fallbackProvider.getTransactionReceipt(txHash);
          }

          methodUsed = 'rpc';
          logger.info('✅ Fallback successful');
        } catch (fallbackError) {
          const errorMsg = `Fallback also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`;
          logger.error(errorMsg);
          errorMessages.push(errorMsg);
        }
      }

      // Check if we have at least some data
      if (!transactionData && !receiptData) {
        const errorMessage = `❌ Failed to retrieve transaction details for hash ${txHash}. Errors: ${errorMessages.join('; ')}`;

        const errorContent: Content = {
          text: errorMessage,
          actions: ['POLYGON_GET_TRANSACTION_DETAILS_ZKEVM'],
          data: { error: errorMessage },
        };

        if (callback) {
          await callback(errorContent);
        }
        return errorContent;
      }

      // Combine transaction data and receipt into a comprehensive response
      const combinedData: any = {
        hash: txHash,
        method: methodUsed,
        timestamp: Date.now(),
      };

      // Add transaction data if available
      if (transactionData) {
        combinedData.transaction = {
          hash: transactionData.hash,
          blockNumber: transactionData.blockNumber,
          blockHash: transactionData.blockHash,
          transactionIndex: transactionData.index,
          from: transactionData.from,
          to: transactionData.to,
          value: transactionData.value?.toString(),
          gasLimit: transactionData.gasLimit?.toString(),
          gasPrice: transactionData.gasPrice?.toString(),
          maxFeePerGas: transactionData.maxFeePerGas?.toString(),
          maxPriorityFeePerGas: transactionData.maxPriorityFeePerGas?.toString(),
          nonce: transactionData.nonce,
          data: transactionData.data,
          chainId: transactionData.chainId,
          type: transactionData.type,
        };
      }

      // Add receipt data if available
      if (receiptData) {
        combinedData.receipt = {
          transactionHash: receiptData.hash,
          blockNumber: receiptData.blockNumber,
          blockHash: receiptData.blockHash,
          transactionIndex: receiptData.index,
          from: receiptData.from,
          to: receiptData.to,
          gasUsed: receiptData.gasUsed?.toString(),
          cumulativeGasUsed: receiptData.cumulativeGasUsed?.toString(),
          effectiveGasPrice: receiptData.gasPrice?.toString(),
          status: receiptData.status,
          contractAddress: receiptData.contractAddress,
          logs: receiptData.logs || [],
          logsBloom: receiptData.logsBloom,
          type: receiptData.type,
        };
      }

      // Calculate gas efficiency if both data are available
      let gasEfficiency = '';
      if (transactionData && receiptData) {
        const gasUsed = BigInt(receiptData.gasUsed?.toString() || '0');
        const gasLimit = BigInt(transactionData.gasLimit?.toString() || '0');
        if (gasLimit > 0n) {
          const efficiency = Number((gasUsed * 100n) / gasLimit);
          gasEfficiency = `\n⛽ Gas Efficiency: ${efficiency.toFixed(2)}% (${gasUsed.toString()}/${gasLimit.toString()})`;
        }
      }

      // Format response text
      let responseText = `📋 **Transaction Details for ${txHash}**\n\n`;

      if (transactionData) {
        const valueInEth = transactionData.value ? Number(transactionData.value) / 1e18 : 0;
        responseText += `**Transaction Info:**\n`;
        responseText += `• From: ${transactionData.from}\n`;
        responseText += `• To: ${transactionData.to || 'Contract Creation'}\n`;
        responseText += `• Value: ${valueInEth.toFixed(6)} ETH\n`;
        responseText += `• Block: ${transactionData.blockNumber}\n`;
        responseText += `• Nonce: ${transactionData.nonce}\n`;
        responseText += `• Gas Limit: ${transactionData.gasLimit?.toString()}\n`;
      }

      if (receiptData) {
        responseText += `\n**Receipt Info:**\n`;
        responseText += `• Status: ${receiptData.status === 1 ? '✅ Success' : '❌ Failed'}\n`;
        responseText += `• Gas Used: ${receiptData.gasUsed?.toString()}\n`;
        responseText += `• Logs Count: ${receiptData.logs?.length || 0}\n`;
        if (receiptData.contractAddress) {
          responseText += `• Contract Created: ${receiptData.contractAddress}\n`;
        }
      }

      responseText += gasEfficiency;
      responseText += `\n\n🔗 Retrieved via ${methodUsed === 'alchemy' ? 'Alchemy API' : 'Direct RPC'}`;

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYGON_GET_TRANSACTION_DETAILS_ZKEVM'],
        data: {
          transactionDetails: combinedData,
        },
      };

      if (callback) {
        await callback(responseContent);
      }
      return responseContent;
    } catch (error) {
      logger.error('❌ Error in GET_TRANSACTION_DETAILS action:', error);

      const errorContent: Content = {
        text: `❌ Error getting transaction details: ${error instanceof Error ? error.message : 'Unknown error'}`,
        actions: ['POLYGON_GET_TRANSACTION_DETAILS_ZKEVM'],
        data: { error: error instanceof Error ? error.message : 'Unknown error' },
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
          text: 'Get details for transaction 0xabc123... on Polygon zkEVM',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting transaction details for 0xabc123... on Polygon zkEVM',
          action: 'POLYGON_GET_TRANSACTION_DETAILS_ZKEVM',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Show me info for tx 0xdef456... on Polygon zkEVM',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Retrieving transaction info for 0xdef456... on Polygon zkEVM',
          action: 'POLYGON_GET_TRANSACTION_DETAILS_ZKEVM',
        },
      },
    ],
  ],
};
