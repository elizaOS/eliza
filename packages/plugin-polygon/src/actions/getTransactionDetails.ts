import { type Action, logger, type IAgentRuntime, type Memory, type State } from '@elizaos/core';
import { formatUnits } from '../utils/formatters.js';
import { PolygonRpcService } from '../services/PolygonRpcService.js';
import { type TransactionDetails, type Hash } from '../types.js';

/**
 * Action to get detailed information about a transaction on Polygon (L2)
 */
export const getTransactionDetailsAction: Action = {
  name: 'POLYGON_GET_L2_TRANSACTION_DETAILS',
  description: 'Gets transaction and receipt details for a transaction on Polygon (L2).',

  // Define examples
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'What are the details for transaction 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef on Polygon?',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting details for transaction 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef on Polygon.',
          action: 'POLYGON_GET_L2_TRANSACTION_DETAILS',
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const content = message.content?.text?.toLowerCase() || '';
    const hasTxHash = /0x[a-fA-F0-9]{64}/.test(content);
    const hasKeyword =
      content.includes('transaction details') || content.includes('details for transaction');
    return hasTxHash && hasKeyword;
  },

  handler: async (runtime: IAgentRuntime, message: Memory) => {
    try {
      const content = message.content?.text || '';
      const txHashMatch = content.match(/0x[a-fA-F0-9]{64}/);

      if (!txHashMatch) {
        throw new Error('Transaction hash not found in the message.');
      }
      const txHash = txHashMatch[0];

      logger.info(`Getting details for transaction ${txHash}`);

      // Get the RPC service
      const rpcService = runtime.getService(PolygonRpcService.serviceType) as PolygonRpcService;
      if (!rpcService) {
        throw new Error('PolygonRpcService not available');
      }

      // Get transaction details
      logger.info(`Fetching transaction details from Polygon network...`);
      const txDetails = await rpcService.getTransactionDetails(txHash as `0x${string}`);

      if (!txDetails || (!txDetails.transaction && !txDetails.receipt)) {
        logger.warn(`Transaction ${txHash} not found`);
        return {
          text: `Transaction ${txHash} not found`,
          actions: ['POLYGON_GET_L2_TRANSACTION_DETAILS'],
          data: { error: `Transaction ${txHash} not found` },
        };
      }

      logger.info(`Successfully retrieved transaction details for ${txHash}`);

      const { transaction, receipt } = txDetails;
      const anyReceipt = receipt as any;

      // Format response for readability
      const status =
        anyReceipt?.status === 1 ? 'Success' : anyReceipt?.status === 0 ? 'Failed' : 'Pending';
      const value = transaction?.value ? formatUnits(BigInt(transaction.value), 18) : '0';
      const gasPrice = transaction?.gasPrice ? formatUnits(BigInt(transaction.gasPrice), 9) : 'N/A';
      const gasUsed = anyReceipt?.gasUsed ? formatUnits(BigInt(anyReceipt.gasUsed), 0) : 'N/A';
      const effectiveGasPrice =
        anyReceipt && anyReceipt.effectiveGasPrice
          ? formatUnits(BigInt(anyReceipt.effectiveGasPrice), 9)
          : 'N/A';
      const txFee =
        anyReceipt?.gasUsed && anyReceipt?.effectiveGasPrice
          ? formatUnits(BigInt(anyReceipt.gasUsed) * BigInt(anyReceipt.effectiveGasPrice), 18)
          : 'N/A';

      // Add more detailed logging
      logger.info(`Transaction ${txHash} status: ${status}`);
      logger.info(`Transaction value: ${value} MATIC`);
      logger.info(`Gas used: ${gasUsed}`);
      logger.info(`Gas price: ${gasPrice} Gwei`);
      logger.info(`Effective gas price: ${effectiveGasPrice} Gwei`);
      logger.info(`Transaction fee: ${txFee} MATIC`);
      logger.info(`From: ${transaction?.from || 'Unknown'}`);
      logger.info(`To: ${transaction?.to || 'Contract creation'}`);
      if (anyReceipt?.blockNumber) {
        logger.info(`Block number: ${anyReceipt.blockNumber}`);
      }

      // Return formatted response
      return {
        text: `Details for tx ${txHash}: Status: ${status}, Value: ${value} MATIC, Fee: ${txFee} MATIC.`,
        actions: ['POLYGON_GET_L2_TRANSACTION_DETAILS'],
        data: {
          hash: txHash,
          status,
          blockNumber: transaction?.blockNumber || anyReceipt?.blockNumber,
          from: transaction?.from || anyReceipt?.from,
          to: transaction?.to || anyReceipt?.to,
          value: `${value} MATIC`,
          gasPrice: `${gasPrice} Gwei`,
          gasUsed,
          effectiveGasPrice: `${effectiveGasPrice} Gwei`,
          txFee: `${txFee} MATIC`,
          timestamp: transaction?.blockNumber ? new Date().toISOString() : undefined,
        },
      };
    } catch (error) {
      logger.error(`Error getting transaction details:`, error);
      return {
        text: `Error getting transaction details: ${
          error instanceof Error ? error.message : String(error)
        }`,
        actions: ['POLYGON_GET_L2_TRANSACTION_DETAILS'],
        data: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  },
};
