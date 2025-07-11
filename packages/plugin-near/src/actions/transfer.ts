import {
  type ActionExample,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelClass,
  type State,
  elizaLogger,
  type Action,
  composeContext,
  generateObject,
} from '@elizaos/core';
import { z } from 'zod';
import { TransactionService } from '../services/TransactionService';
import { NearPluginError, formatErrorMessage, isNearError } from '../core/errors';
import type { TransferContent, TransferParams } from '../core/types';

export const TransferSchema = z.object({
  recipient: z.string(),
  amount: z.string(),
  tokenAddress: z.string().optional().nullable(),
});

const transferTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "recipient": "bob.near",
    "amount": "1.5",
    "tokenAddress": null
}
\`\`\`

{{recentMessages}}

Given the recent messages and wallet information below:

{{walletInfo}}

Extract the following information about the requested token transfer:
- Recipient address (NEAR account)
- Amount to transfer
- Token contract address (null for native NEAR transfers)

Respond with a JSON markdown block containing only the extracted values.`;

export const executeTransfer: Action = {
  name: 'SEND_NEAR',
  similes: ['TRANSFER_NEAR', 'SEND_TOKENS', 'TRANSFER_TOKENS', 'PAY_NEAR'],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => {
    return true;
  },
  description: 'Transfer NEAR tokens or NEP-141 tokens to another account',
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<boolean> => {
    try {
      // Initialize or update state
      let currentState: State;

      if (!state) {
        currentState = (await runtime.composeState(message)) as State;
      } else {
        currentState = await runtime.updateRecentMessageState(state);
      }

      // Compose transfer context
      const transferContext = composeContext({
        state: currentState,
        template: transferTemplate,
      });

      // Generate transfer content
      const generatedResult = await generateObject({
        runtime,
        context: transferContext,
        modelClass: ModelClass.SMALL,
        schema: TransferSchema,
      });

      const content = generatedResult.object as z.infer<typeof TransferSchema>;

      // Validate content
      if (!content || !content.recipient || !content.amount) {
        elizaLogger.error('Invalid content for SEND_NEAR action.');
        callback?.({
          text: 'I need the recipient address and amount to make a transfer.',
          content: { error: 'Missing required parameters' },
        });
        return false;
      }

      // Get transaction service
      const transactionService = runtime.getService(
        'near-transaction' as any
      ) as TransactionService;

      if (!transactionService) {
        throw new Error('Transaction service not available');
      }

      // Prepare transfer parameters
      const params: TransferParams = {
        recipient: content.recipient,
        amount: content.amount,
        tokenId: content.tokenAddress || undefined,
      };

      // Execute transfer
      elizaLogger.info(
        `Executing transfer: ${params.amount} ${params.tokenId || 'NEAR'} to ${params.recipient}`
      );

      const result = params.tokenId
        ? await transactionService.sendToken(params)
        : await transactionService.sendNear(params);

      // Send success response
      const tokenSymbol = params.tokenId || 'NEAR';
      callback?.({
        text: `Successfully transferred ${params.amount} ${tokenSymbol} to ${params.recipient}`,
        content: {
          success: true,
          transactionHash: result.transactionHash,
          explorerUrl: result.explorerUrl,
          recipient: params.recipient,
          amount: params.amount,
          token: tokenSymbol,
        },
      });

      return true;
    } catch (error) {
      elizaLogger.error('Error during NEAR transfer:', error);

      // Format error message
      let errorMessage = 'Error transferring tokens';
      if (isNearError(error)) {
        errorMessage = formatErrorMessage(error);
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      callback?.({
        text: errorMessage,
        content: {
          error: errorMessage,
          details: error,
        },
      });

      return false;
    }
  },

  examples: [
    [
      {
        user: '{{user1}}',
        content: {
          text: 'Send 1.5 NEAR to alice.near',
        },
      },
      {
        user: '{{agentName}}',
        content: {
          text: "I'll send 1.5 NEAR to alice.near now...",
          action: 'SEND_NEAR',
        },
      },
      {
        user: '{{agentName}}',
        content: {
          text: 'Successfully transferred 1.5 NEAR to alice.near',
          content: {
            transactionHash: '4jK3x...',
            explorerUrl: 'https://explorer.testnet.near.org/transactions/4jK3x...',
          },
        },
      },
    ],
    [
      {
        user: '{{user1}}',
        content: {
          text: 'Transfer 100 USDC to bob.near',
        },
      },
      {
        user: '{{agentName}}',
        content: {
          text: "I'll transfer 100 USDC to bob.near...",
          action: 'SEND_NEAR',
        },
      },
      {
        user: '{{agentName}}',
        content: {
          text: 'Successfully transferred 100 USDC to bob.near',
          content: {
            transactionHash: '7mN9y...',
            token: 'usdc.fakes.testnet',
          },
        },
      },
    ],
  ] as ActionExample[][],
};
