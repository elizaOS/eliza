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
import { CrossChainService } from '../services/CrossChainService';
import { NearPluginError, formatErrorMessage, isNearError } from '../core/errors';

export const CrossChainTransferSchema = z.object({
  chain: z.enum(['ethereum', 'aurora']), // Only supported chains
  recipient: z.string(),
  amount: z.string(),
  tokenId: z.string(),
});

const crossChainTemplate = `Extract cross-chain transfer parameters from the conversation:

Recent messages:
{{recentMessages}}

Extract:
1. Target blockchain (ethereum or aurora)
2. Recipient address on the target chain
3. Amount to transfer
4. Token ID (use "NEAR" for native NEAR token)

Respond with a JSON object containing these fields.`;

const crossChainExamples: ActionExample[][] = [
  [
    {
      user: 'alice',
      content: {
        text: 'Send 5 NEAR to 0x742d35Cc6634C0532925a3b844Bc9e7595f8f123 on Aurora',
        source: 'discord',
      },
    },
    {
      user: 'agent',
      content: {
        text: "I'll transfer 5 NEAR to your Aurora address...",
        action: 'CROSS_CHAIN_TRANSFER',
      },
    },
    {
      user: 'agent',
      content: {
        text: 'Successfully transferred 5 NEAR to Aurora. Transaction hash: 0xabc123...',
      },
    },
  ],
  [
    {
      user: 'bob',
      content: {
        text: 'Bridge 100 USDT to Ethereum address 0x123...',
        source: 'telegram',
      },
    },
    {
      user: 'agent',
      content: {
        text: "I'll bridge 100 USDT to Ethereum via Rainbow Bridge...",
        action: 'CROSS_CHAIN_TRANSFER',
      },
    },
  ],
];

export const executeCrossChainTransfer: Action = {
  name: 'CROSS_CHAIN_TRANSFER',
  similes: ['BRIDGE_TOKENS', 'CROSS_CHAIN_SEND', 'TRANSFER_TO_ETHEREUM', 'SEND_TO_AURORA'],
  description: 'Transfer tokens cross-chain to Ethereum or Aurora',

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const crossChainService = runtime.getService<CrossChainService>('near-crosschain' as any);
    return !!crossChainService;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<boolean> => {
    try {
      const crossChainService = runtime.getService<CrossChainService>('near-crosschain' as any);
      if (!crossChainService) {
        throw new NearPluginError('UNKNOWN_ERROR' as any, 'CrossChain service not available');
      }

      // Get or compose state
      const currentState = state || (await runtime.composeState(message));

      // Extract transfer parameters
      const transferContext = composeContext({
        state: currentState,
        template: crossChainTemplate,
      });

      const generatedResult = await generateObject({
        runtime,
        context: transferContext,
        modelClass: ModelClass.SMALL,
        schema: CrossChainTransferSchema,
      });

      const content = generatedResult.object as z.infer<typeof CrossChainTransferSchema>;

      if (!content || !content.chain || !content.recipient || !content.amount) {
        await callback?.({
          text: 'I need the target blockchain (ethereum or aurora), recipient address, and amount to make a cross-chain transfer.',
        });
        return false;
      }

      elizaLogger.info(`Executing cross-chain transfer to ${content.chain}:`, content);

      let txHash: string;

      // Execute the appropriate cross-chain transfer
      switch (content.chain) {
        case 'aurora':
          txHash = await crossChainService.transferToAurora(
            content.tokenId,
            content.amount,
            content.recipient
          );
          break;

        case 'ethereum':
          txHash = await crossChainService.bridgeToEthereum(
            content.tokenId,
            content.amount,
            content.recipient
          );
          break;

        default:
          throw new NearPluginError('UNKNOWN_ERROR' as any, `Unsupported chain: ${content.chain}`);
      }

      await callback?.({
        text: `Successfully initiated cross-chain transfer of ${content.amount} ${content.tokenId} to ${content.recipient} on ${content.chain}. Transaction hash: ${txHash}`,
        content: {
          success: true,
          chain: content.chain,
          transactionHash: txHash,
          recipient: content.recipient,
          amount: content.amount,
          tokenId: content.tokenId,
          action: 'CROSS_CHAIN_TRANSFER',
        },
      });

      return true;
    } catch (error) {
      elizaLogger.error('Cross-chain transfer error:', error);

      const errorMessage = isNearError(error)
        ? formatErrorMessage(error)
        : 'Failed to execute cross-chain transfer';

      await callback?.({
        text: errorMessage,
        content: {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      });

      return false;
    }
  },

  examples: crossChainExamples,
};

export const CrossChainSwapSchema = z.object({
  fromTokenId: z.string(),
  toTokenId: z.string(),
  amount: z.string(),
  targetChain: z.enum(['ethereum', 'aurora']),
});

const swapTemplate = `Extract cross-chain swap parameters from the conversation:

Recent messages:
{{recentMessages}}

User wants to swap tokens across chains. Extract:
1. From token ID on NEAR
2. To token ID on target chain
3. Amount to swap
4. Target chain (ethereum or aurora)

Respond with a JSON object.`;

export const executeCrossChainSwap: Action = {
  name: 'CROSS_CHAIN_SWAP',
  similes: ['BRIDGE_SWAP', 'CROSS_CHAIN_EXCHANGE'],
  description: 'Swap tokens across chains between NEAR and Ethereum/Aurora',

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const crossChainService = runtime.getService<CrossChainService>('near-crosschain' as any);
    if (!crossChainService) {
      return false;
    }

    const text = message.content.text?.toLowerCase() || '';
    return text.includes('swap') && (text.includes('ethereum') || text.includes('aurora'));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<boolean> => {
    try {
      const crossChainService = runtime.getService<CrossChainService>('near-crosschain' as any);
      if (!crossChainService) {
        throw new NearPluginError('UNKNOWN_ERROR' as any, 'CrossChain service not available');
      }

      const currentState = state || (await runtime.composeState(message));

      const swapContext = composeContext({
        state: currentState,
        template: swapTemplate,
      });

      const generatedResult = await generateObject({
        runtime,
        context: swapContext,
        modelClass: ModelClass.SMALL,
        schema: CrossChainSwapSchema,
      });

      const content = generatedResult.object as z.infer<typeof CrossChainSwapSchema>;

      if (!content) {
        await callback?.({
          text: 'I need to know which tokens to swap and the target chain.',
        });
        return false;
      }

      elizaLogger.info('Initiating cross-chain swap:', content);

      // Validate that we have the user's Ethereum address
      const ethereumAddress = runtime.getSetting('USER_ETHEREUM_ADDRESS');
      if (!ethereumAddress) {
        await callback?.({
          text: 'I need your Ethereum address to complete the cross-chain swap. Please provide it in your settings.',
        });
        return false;
      }

      // First, bridge the tokens
      const txHash = await crossChainService.bridgeToEthereum(
        content.fromTokenId,
        content.amount,
        ethereumAddress
      );

      await callback?.({
        text: `Cross-chain swap initiated. First step: bridging ${content.amount} ${content.fromTokenId} to ${content.targetChain}. Transaction: ${txHash}. 
        
Note: You'll need to complete the swap on ${content.targetChain} once the bridge transfer completes.`,
        content: {
          success: true,
          step: 'bridge_initiated',
          transactionHash: txHash,
          fromToken: content.fromTokenId,
          amount: content.amount,
          targetChain: content.targetChain,
          action: 'CROSS_CHAIN_SWAP',
        },
      });

      return true;
    } catch (error) {
      elizaLogger.error('Cross-chain swap error:', error);

      const errorMessage = isNearError(error)
        ? formatErrorMessage(error)
        : 'Failed to execute cross-chain swap';

      await callback?.({
        text: errorMessage,
        content: {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      });

      return false;
    }
  },

  examples: [
    [
      {
        user: 'alice',
        content: {
          text: 'Swap 10 NEAR for ETH on Ethereum',
        },
      },
      {
        user: 'agent',
        content: {
          text: "I'll help you swap NEAR for ETH across chains...",
          action: 'CROSS_CHAIN_SWAP',
        },
      },
    ],
  ],
};

export const crossChainActions = [executeCrossChainTransfer, executeCrossChainSwap];
