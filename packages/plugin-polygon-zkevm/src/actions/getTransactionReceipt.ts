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
import { getTransactionReceiptTemplate } from '../templates';
import { JsonRpcProvider } from 'ethers';

/**
 * Get transaction receipt action for Polygon zkEVM
 * Retrieves transaction receipt details by transaction hash
 */
export const getTransactionReceiptAction: Action = {
  name: 'POLYGON_ZKEVM_GET_TRANSACTION_RECEIPT',
  similes: ['GET_TX_RECEIPT', 'TRANSACTION_RECEIPT', 'TX_RECEIPT', 'RECEIPT'].map(
    (s) => `POLYGON_ZKEVM_${s}`
  ),
  description: 'Gets the transaction receipt for a given hash on Polygon zkEVM.',

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
      logger.info('Handling GET_TRANSACTION_RECEIPT_ZKEVM action');

      // Extract transaction hash from message
      const text = message.content.text;
      const txHashMatch = text.match(/0x[a-fA-F0-9]{64}/);

      if (!txHashMatch) {
        const errorContent: Content = {
          text: 'Please provide a valid transaction hash (0x... 64 characters) to get the transaction receipt.',
          actions: ['POLYGON_GET_TRANSACTION_RECEIPT_ZKEVM'],
          source: message.content.source,
        };
        await callback(errorContent);
        return errorContent;
      }

      const txHash = txHashMatch[0];

      // Setup provider - prefer Alchemy, fallback to RPC
      let provider: JsonRpcProvider;
      const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');

      if (alchemyApiKey) {
        provider = new JsonRpcProvider(
          `${runtime.getSetting('ZKEVM_ALCHEMY_URL') || 'https://polygonzkevm-mainnet.g.alchemy.com/v2'}/${alchemyApiKey}`
        );
      } else {
        const zkevmRpcUrl =
          runtime.getSetting('ZKEVM_RPC_URL') ||
          runtime.getSetting('ZKEVM_RPC_URL') ||
          'https://zkevm-rpc.com';
        provider = new JsonRpcProvider(zkevmRpcUrl);
      }

      // Get transaction receipt
      const receipt = await provider.getTransactionReceipt(txHash);

      if (!receipt) {
        const errorContent: Content = {
          text: `Transaction receipt not found: ${txHash}. The transaction may be pending or does not exist.`,
          actions: ['POLYGON_GET_TRANSACTION_RECEIPT_ZKEVM'],
          source: message.content.source,
        };
        await callback(errorContent);
        return errorContent;
      }

      // Format receipt details
      const gasUsedPercent = 'N/A'; // Gas limit not available in receipt
      const effectiveGasPriceGwei = receipt.gasPrice
        ? (Number(receipt.gasPrice) / 1e9).toFixed(2)
        : 'N/A';
      const status = receipt.status === 1 ? '✅ Success' : '❌ Failed';

      let responseText = `Transaction Receipt for ${txHash}:
📋 Hash: ${receipt.hash}
🔗 Block: ${receipt.blockNumber}
📍 From: ${receipt.from}
📍 To: ${receipt.to || 'Contract Creation'}
📊 Status: ${status}
⛽ Gas Used: ${receipt.gasUsed?.toString()} (${gasUsedPercent}% of limit)
💸 Effective Gas Price: ${effectiveGasPriceGwei} Gwei
🔢 Transaction Index: ${receipt.index}`;

      // Add contract address if it's a contract creation
      if (receipt.contractAddress) {
        responseText += `\n🏗️ Contract Created: ${receipt.contractAddress}`;
      }

      // Add logs information
      if (receipt.logs && receipt.logs.length > 0) {
        responseText += `\n📝 Logs: ${receipt.logs.length} events emitted`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYGON_GET_TRANSACTION_RECEIPT_ZKEVM'],
        source: message.content.source,
      };

      await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('Error in GET_TRANSACTION_RECEIPT_ZKEVM action:', error);

      const errorContent: Content = {
        text: `Error getting transaction receipt: ${error instanceof Error ? error.message : 'Unknown error'}`,
        actions: ['POLYGON_GET_TRANSACTION_RECEIPT_ZKEVM'],
        source: message.content.source,
      };

      await callback(errorContent);
      return errorContent;
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Get receipt for transaction 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef on Polygon zkEVM',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: `Transaction Receipt for 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef:
📋 Hash: 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
🔗 Block: 12345
📍 From: 0xabc123...
📍 To: 0xdef456...
📊 Status: ✅ Success
⛽ Gas Used: 21000 (100.00% of limit)
💸 Effective Gas Price: 20.00 Gwei
🔢 Transaction Index: 0`,
          action: 'POLYGON_GET_TRANSACTION_RECEIPT_ZKEVM',
        },
      },
    ],
  ],
};
