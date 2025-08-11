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
import { getTransactionByHashTemplate } from '../templates';
import { callLLMWithTimeout } from '../utils/llmHelpers';

/**
 * Get transaction by hash action for Polygon zkEVM
 * Retrieves transaction details by transaction hash
 */
export const getTransactionByHashAction: Action = {
  name: 'POLYGON_ZKEVM_GET_TRANSACTION_BY_HASH',
  similes: ['GET_TX_BY_HASH', 'GET_TRANSACTION', 'TRANSACTION_DETAILS', 'TX_DETAILS'].map(
    (s) => `POLYGON_ZKEVM_${s}`
  ),
  description: 'Gets transaction details for a given hash on Polygon zkEVM.',

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
      logger.info('[getTransactionByHashAction] Handler called!');

      const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
      const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

      if (!alchemyApiKey && !zkevmRpcUrl) {
        const errorMessage = 'ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.';
        logger.error(`[getTransactionByHashAction] Configuration error: ${errorMessage}`);
        const errorContent: Content = {
          text: errorMessage,
          actions: ['POLYGON_GET_TRANSACTION_BY_HASH_ZKEVM'],
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
          getTransactionByHashTemplate,
          'getTransactionByHashAction'
        );

        if (hashInput?.error) {
          logger.error('[getTransactionByHashAction] LLM returned an error:', hashInput?.error);
          throw new Error(hashInput?.error);
        }

        if (!hashInput?.transactionHash || typeof hashInput.transactionHash !== 'string') {
          throw new Error('Invalid transaction hash received from LLM.');
        }
      } catch (error) {
        logger.error(
          '[getTransactionByHashAction] OBJECT_LARGE model failed',
          error instanceof Error ? error : undefined
        );
        throw new Error(
          `[getTransactionByHashAction] Failed to extract transaction hash from input: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      const txHash = hashInput.transactionHash;

      // Setup provider - prefer Alchemy, fallback to RPC
      let provider: JsonRpcProvider;
      const zkevmAlchemyUrl =
        runtime.getSetting('ZKEVM_ALCHEMY_URL') || 'https://polygonzkevm-mainnet.g.alchemy.com/v2';

      if (alchemyApiKey) {
        provider = new JsonRpcProvider(`${zkevmAlchemyUrl}/${alchemyApiKey}`);
      } else {
        provider = new JsonRpcProvider(zkevmRpcUrl);
      }

      // Get transaction details
      const transaction = await provider.getTransaction(txHash);

      if (!transaction) {
        const errorContent: Content = {
          text: `❌ Transaction not found: ${txHash}`,
          actions: ['POLYGON_GET_TRANSACTION_BY_HASH_ZKEVM'],
        };
        if (callback) {
          await callback(errorContent);
        }
        return errorContent;
      }

      // Format transaction details
      const valueInEth = Number(transaction.value) / 1e18;
      const gasPriceInGwei = transaction.gasPrice ? Number(transaction.gasPrice) / 1e9 : 'N/A';

      const responseText = `🔍 **Transaction Details (Polygon zkEVM)**

**Basic Information:**
- Hash: \`${transaction.hash}\`
- Block Number: ${transaction.blockNumber || 'Pending'}
- Block Hash: \`${transaction.blockHash || 'Pending'}\`
- Transaction Index: ${transaction.index !== null ? transaction.index : 'Pending'}

**Transaction Data:**
- From: \`${transaction.from}\`
- To: \`${transaction.to || 'Contract Creation'}\`
- Value: ${valueInEth} ETH
- Gas Limit: ${transaction.gasLimit?.toString() || 'N/A'}
- Gas Price: ${gasPriceInGwei} Gwei
- Nonce: ${transaction.nonce}

**Status:**
- Confirmations: ${transaction.confirmations || 0}
- Type: ${transaction.type || 'Legacy'}

${transaction.data && transaction.data !== '0x' ? `**Data:** \`${transaction.data.slice(0, 100)}${transaction.data.length > 100 ? '...' : ''}\`` : ''}`;

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYGON_GET_TRANSACTION_BY_HASH_ZKEVM'],
        data: {
          transaction: {
            hash: transaction.hash,
            blockNumber: transaction.blockNumber,
            blockHash: transaction.blockHash,
            from: transaction.from,
            to: transaction.to,
            value: transaction.value?.toString(),
            gasLimit: transaction.gasLimit?.toString(),
            gasPrice: transaction.gasPrice?.toString(),
            nonce: transaction.nonce,
            confirmations: transaction.confirmations,
            type: transaction.type,
            data: transaction.data,
          },
          network: 'polygon-zkevm',
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      const errorMessage = `Failed to get transaction details: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMessage);

      const errorContent: Content = {
        text: `❌ ${errorMessage}`,
        actions: ['POLYGON_GET_TRANSACTION_BY_HASH_ZKEVM'],
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
          text: 'Get details for transaction 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef on Polygon zkEVM',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll get the transaction details for that hash on Polygon zkEVM.",
          action: 'POLYGON_GET_TRANSACTION_BY_HASH_ZKEVM',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Show me transaction 0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890 on Polygon zkEVM',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me fetch the details for that transaction on Polygon zkEVM.',
          action: 'POLYGON_GET_TRANSACTION_BY_HASH_ZKEVM',
        },
      },
    ],
  ],
};
