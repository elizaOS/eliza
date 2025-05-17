import { type Action, logger, type IAgentRuntime } from '@elizaos/core';
import { z } from 'zod';
import { formatUnits } from '../utils/formatters.js';
import { PolygonRpcService } from '../services/PolygonRpcService.js';
import { type TransactionDetails, type Hash } from '../types.js';

/**
 * Transaction options schema using Zod
 */
const txOptionsSchema = z.object({
  txHash: z.string()
    .refine(hash => /^0x[a-fA-F0-9]{64}$/.test(hash), {
      message: 'Transaction hash must be a valid 0x-prefixed hex string with 64 characters after prefix'
    })
});

/**
 * Action to get detailed information about a transaction on Polygon (L2)
 */
export const getTransactionDetailsAction: Action = {
  name: 'GET_L2_TRANSACTION_DETAILS',
  description: 'Gets transaction and receipt details for a transaction on Polygon (L2).',
  
  // Define examples
  examples: [
    "What are the details for transaction 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef on Polygon?",
    "Show me the transaction receipt for 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "Get information about Polygon transaction 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
  ],
  
  validate: async (options: any, runtime: IAgentRuntime) => {
    try {
      // Check if POLYGON_RPC_URL is set in environment
      const polygonRpcUrl = runtime.getSetting('POLYGON_RPC_URL');
      if (!polygonRpcUrl) {
        return 'POLYGON_RPC_URL setting is required to get transaction details';
      }
      
      // Validate transaction hash format
      txOptionsSchema.parse(options);
      return true;
    } catch (error) {
      if (error instanceof z.ZodError) {
        logger.error('Validation error:', error.errors);
        return error.errors[0].message;
      }
      logger.error('Unexpected validation error:', error);
      return 'Invalid transaction options';
    }
  },
  
  execute: async (options: any, runtime: IAgentRuntime) => {
    try {
      const { txHash } = options as { txHash: string };
      
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
          actions: ['GET_L2_TRANSACTION_DETAILS'],
          data: { error: `Transaction ${txHash} not found` }
        };
      }
      
      logger.info(`Successfully retrieved transaction details for ${txHash}`);
      
      const { transaction, receipt } = txDetails;
      
      // Format response for readability
      const status = receipt?.status === 1 ? 'Success' : receipt?.status === 0 ? 'Failed' : 'Pending';
      const value = transaction?.value ? formatUnits(BigInt(transaction.value), 18) : '0';
      const gasPrice = transaction?.gasPrice ? formatUnits(BigInt(transaction.gasPrice), 9) : 'N/A';
      const gasUsed = receipt?.gasUsed ? formatUnits(BigInt(receipt.gasUsed), 0) : 'N/A';
      const effectiveGasPrice = receipt?.effectiveGasPrice 
        ? formatUnits(BigInt(receipt.effectiveGasPrice), 9) 
        : 'N/A';
      const txFee = (receipt?.gasUsed && receipt?.effectiveGasPrice) 
        ? formatUnits(BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice), 18) 
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
      if (receipt?.blockNumber) {
        logger.info(`Block number: ${receipt.blockNumber}`);
      }
      
      // Return formatted response
      return {
        actions: ['GET_L2_TRANSACTION_DETAILS'],
        data: {
          hash: txHash,
          status,
          blockNumber: transaction?.blockNumber || receipt?.blockNumber,
          from: transaction?.from || receipt?.from,
          to: transaction?.to || receipt?.to,
          value: `${value} MATIC`,
          gasPrice: `${gasPrice} Gwei`,
          gasUsed,
          effectiveGasPrice: `${effectiveGasPrice} Gwei`,
          txFee: `${txFee} MATIC`,
          timestamp: transaction?.blockNumber ? new Date().toISOString() : undefined,
        }
      };
    } catch (error) {
      logger.error(`Error getting transaction details:`, error);
      return {
        actions: ['GET_L2_TRANSACTION_DETAILS'],
        data: { error: error instanceof Error ? error.message : String(error) }
      };
    }
  },
}; 