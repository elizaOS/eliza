import { Action, IAgentRuntime, logger, Memory } from '@elizaos/core';
import { initializeQuickswapClient } from '../utils/quickswapClient.js';
import { z } from 'zod';

/**
 * M5-06: Fetches the status of a Quickswap transaction.
 */
export const getTransactionStatusAction: Action = {
  name: 'QUICKSWAP_GET_TRANSACTION_STATUS',
  description: 'Fetches the current status of a transaction on Quickswap using its hash.',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info(
      `[getTransactionStatusAction] Validate called for message: "${message.content?.text}"`
    );

    const quickswapApiUrl = runtime.getSetting('QUICKSWAP_API_URL');

    if (!quickswapApiUrl) {
      logger.warn('[getTransactionStatusAction] QUICKSWAP_API_URL is required but not provided');
      return false;
    }

    logger.info('[getTransactionStatusAction] Validation passed');
    return true;
  },
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    try {
      const parsedParams = z
        .object({
          transactionHash: z.string().describe('The hash of the transaction to check.'),
        })
        .parse(message.content);

      const { transactionHash } = parsedParams;

      // Initialize Quickswap client
      const quickswapClient = await initializeQuickswapClient(runtime);

      // Execute get transaction status logic using the client
      const statusResult = await quickswapClient.GetTransactionStatus(transactionHash);

      if (statusResult.success) {
        const responseText = `✅ **Transaction Status**\n\n**Transaction Details:**\n• **Hash**: ${transactionHash}\n• **Status**: ${statusResult.status}\n• **Block Number**: ${statusResult.blockNumber || 'Pending'}\n• **Gas Used**: ${statusResult.gasUsed || 'Pending'}\n• **From**: ${statusResult.from}\n• **To**: ${statusResult.to}\n• **Value**: ${statusResult.value}`;
        return {
          text: responseText,
          actions: ['getTransactionStatus'],
          data: {
            success: true,
            statusDetails: statusResult,
            timestamp: new Date().toISOString(),
          },
        };
      } else {
        return {
          text: `❌ **Error**: ${statusResult.error || 'Failed to get transaction status.'}`,
          actions: ['getTransactionStatus'],
          data: {
            success: false,
            error: statusResult.error,
            transactionHash,
            timestamp: new Date().toISOString(),
          },
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof z.ZodError
          ? `Invalid parameters: ${error.errors.map((e) => e.message).join(', ')}`
          : error instanceof Error
            ? error.message
            : 'Unknown error occurred while getting transaction status';
      logger.error(`[getTransactionStatusAction] Error getting transaction status:`, error);
      return {
        text: `❌ **Error**: ${errorMessage}`,
        actions: ['getTransactionStatus'],
        data: {
          error: errorMessage,
          timestamp: new Date().toISOString(),
        },
      };
    }
  },
};
