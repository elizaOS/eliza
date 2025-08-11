import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type Handler,
  type HandlerCallback,
  type Content,
  logger,
  elizaLogger,
} from '@elizaos/core';
import { ethers } from 'ethers';
import { PolygonRpcService } from '../services/PolygonRpcService.js';
import { initWalletProvider } from '../providers/PolygonWalletProvider.js';

export const getMaticBalanceAction: Action = {
  name: 'POLYGON_GET_MATIC_BALANCE',
  similes: ['CHECK_MATIC_BALANCE', 'SHOW_BALANCE', 'GET_NATIVE_BALANCE'].map((s) => `POLYGON_${s}`),
  description: 'Gets the native MATIC balance for the agent wallet on Polygon.',
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const content = message.content?.text?.toLowerCase() || '';

    // Add debug logging to see if this is being called
    logger.info(`[getMaticBalanceAction] VALIDATION CALLED - message: "${content}"`);

    try {
      // Check for MATIC balance related keywords
      const maticBalanceKeywords = [
        'matic balance',
        'get matic balance',
        'show matic balance',
        'check matic balance',
        'my matic balance',
        'polygon balance',
        'balance on polygon',
        'how much matic',
        'matic amount',
        'show me my matic',
        'what is my matic balance',
        'check my matic',
      ];

      const matches = maticBalanceKeywords.some((keyword) => content.includes(keyword));
      logger.info(
        `[getMaticBalanceAction] Validation result: ${matches} (keywords checked: ${maticBalanceKeywords.length})`
      );

      // Also check if we have required services
      const rpcService = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!rpcService) {
        logger.warn(`[getMaticBalanceAction] PolygonRpcService not available - validation false`);
        return false;
      }

      return matches;
    } catch (error) {
      logger.error(`[getMaticBalanceAction] Validation error:`, error);
      return false;
    }
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getMaticBalanceAction] Handler called!');

    const rpcService = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
    if (!rpcService) throw new Error('PolygonRpcService not available');

    try {
      const polygonWalletProvider = await initWalletProvider(runtime);
      if (!polygonWalletProvider) {
        throw new Error(
          'Failed to initialize PolygonWalletProvider - check that PRIVATE_KEY is configured correctly'
        );
      }
      const agentAddress = polygonWalletProvider.getAddress();
      if (!agentAddress) throw new Error('Could not determine agent address from provider');

      logger.info(`Fetching MATIC balance for address: ${agentAddress}`);
      const balanceWei = await rpcService.getBalance(agentAddress, 'L2');
      elizaLogger.info(`Balance: ${balanceWei}`);
      const balanceMatic = ethers.formatEther(balanceWei);

      const responseContent: Content = {
        text: `Your MATIC balance on Polygon (${agentAddress}): ${balanceMatic} MATIC`,
        actions: ['POLYGON_GET_MATIC_BALANCE'],
        data: {
          address: agentAddress,
          balanceWei: balanceWei.toString(),
          balanceMatic,
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      logger.error('Error getting MATIC balance:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const userMessage = errorMessage.includes('private key')
        ? 'There was an issue with the wallet configuration. Please ensure PRIVATE_KEY is correctly set.'
        : `Error retrieving MATIC balance: ${errorMessage}`;

      const errorContent: Content = {
        text: userMessage,
        actions: ['POLYGON_GET_MATIC_BALANCE'],
        data: { error: errorMessage },
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
          text: 'get matic balance on polygon',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Your MATIC balance on Polygon (0x1234...): 17.856183245623432226 MATIC',
          action: 'POLYGON_GET_MATIC_BALANCE',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'what is my polygon balance?',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Your MATIC balance on Polygon (0x1234...): 17.856183245623432226 MATIC',
          action: 'POLYGON_GET_MATIC_BALANCE',
        },
      },
    ],
  ],
};
