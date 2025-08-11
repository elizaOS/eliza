import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  type Content,
  logger,
} from '@elizaos/core';
import { ethers } from 'ethers';
import { PolygonRpcService } from '../services/PolygonRpcService.js';
import { initWalletProvider } from '../providers/PolygonWalletProvider.js';

// Common token addresses on Polygon
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC on Polygon
const WETH_ADDRESS = '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619'; // WETH on Polygon

export const getUSDCBalanceAction: Action = {
  name: 'POLYGON_GET_USDC_BALANCE',
  similes: ['CHECK_USDC_BALANCE', 'SHOW_USDC_BALANCE', 'GET_USDC_AMOUNT'].map(
    (s) => `POLYGON_${s}`
  ),
  description: 'Gets the USDC balance for the agent wallet on Polygon.',
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const content = message.content?.text?.toLowerCase() || '';

    logger.info(`[getUSDCBalanceAction] VALIDATION CALLED - message: "${content}"`);

    try {
      // Check for USDC balance related keywords
      const usdcKeywords = [
        'usdc balance',
        'usdc amount',
        'my usdc',
        'get usdc',
        'show usdc',
        'check usdc',
        'usdc wallet',
        'balance usdc',
        'how much usdc',
      ];

      const matches = usdcKeywords.some((keyword) => content.includes(keyword));
      logger.info(`[getUSDCBalanceAction] Validation result: ${matches}`);

      // Also check if we have required services
      const rpcService = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!rpcService) {
        logger.warn(`[getUSDCBalanceAction] PolygonRpcService not available - validation false`);
        return false;
      }

      return matches;
    } catch (error) {
      logger.error(`[getUSDCBalanceAction] Validation error:`, error);
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
    logger.info('[getUSDCBalanceAction] Handler called!');

    const rpcService = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
    if (!rpcService) {
      throw new Error('PolygonRpcService not available');
    }

    try {
      // Get agent wallet address using the wallet provider
      const polygonWalletProvider = await initWalletProvider(runtime);
      if (!polygonWalletProvider) {
        throw new Error(
          'Failed to initialize PolygonWalletProvider - check that PRIVATE_KEY is configured correctly'
        );
      }
      const agentAddress = polygonWalletProvider.getAddress();
      if (!agentAddress) {
        throw new Error('Could not determine agent address from provider');
      }

      logger.info(`Getting USDC balance for address: ${agentAddress}`);

      // Get USDC balance
      const balance = await rpcService.getErc20Balance(USDC_ADDRESS, agentAddress);

      // USDC has 6 decimals on Polygon
      const formattedBalance = ethers.formatUnits(balance, 6);

      const responseContent: Content = {
        text: `Your USDC balance (${agentAddress}): ${formattedBalance} USDC`,
        actions: ['GET_USDC_BALANCE'],
        data: {
          address: agentAddress,
          tokenAddress: USDC_ADDRESS,
          balance: balance.toString(),
          formattedBalance,
          symbol: 'USDC',
          decimals: 6,
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      logger.error('Error getting USDC balance:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      const errorContent: Content = {
        text: `Error retrieving USDC balance: ${errorMessage}`,
        actions: ['GET_USDC_BALANCE'],
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
        name: 'user',
        content: {
          text: 'get my usdc balance',
        },
      },
      {
        name: 'assistant',
        content: {
          text: 'Your USDC balance (0x1234...): 1,250.50 USDC',
          actions: ['GET_USDC_BALANCE'],
        },
      },
    ],
    [
      {
        name: 'user',
        content: {
          text: 'how much usdc do i have',
        },
      },
      {
        name: 'assistant',
        content: {
          text: 'Your USDC balance (0x1234...): 1,250.50 USDC',
          actions: ['GET_USDC_BALANCE'],
        },
      },
    ],
  ],
};

export const getWETHBalanceAction: Action = {
  name: 'POLYGON_GET_WETH_BALANCE',
  similes: ['CHECK_WETH_BALANCE', 'SHOW_WETH_BALANCE', 'GET_WETH_AMOUNT'].map(
    (s) => `POLYGON_${s}`
  ),
  description: 'Gets the WETH balance for the agent wallet on Polygon.',
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const content = message.content?.text?.toLowerCase() || '';

    logger.info(`[getWETHBalanceAction] VALIDATION CALLED - message: "${content}"`);

    try {
      // Check for WETH balance related keywords
      const wethKeywords = [
        'weth balance',
        'weth amount',
        'my weth',
        'get weth',
        'show weth',
        'check weth',
        'weth wallet',
        'balance weth',
        'how much weth',
        'wrapped eth',
        'wrapped ethereum',
      ];

      const matches = wethKeywords.some((keyword) => content.includes(keyword));
      logger.info(`[getWETHBalanceAction] Validation result: ${matches}`);

      // Also check if we have required services
      const rpcService = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!rpcService) {
        logger.warn(`[getWETHBalanceAction] PolygonRpcService not available - validation false`);
        return false;
      }

      return matches;
    } catch (error) {
      logger.error(`[getWETHBalanceAction] Validation error:`, error);
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
    logger.info('[getWETHBalanceAction] Handler called!');

    const rpcService = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
    if (!rpcService) {
      throw new Error('PolygonRpcService not available');
    }

    try {
      // Get agent wallet address using the wallet provider
      const polygonWalletProvider = await initWalletProvider(runtime);
      if (!polygonWalletProvider) {
        throw new Error(
          'Failed to initialize PolygonWalletProvider - check that PRIVATE_KEY is configured correctly'
        );
      }
      const agentAddress = polygonWalletProvider.getAddress();
      if (!agentAddress) {
        throw new Error('Could not determine agent address from provider');
      }

      logger.info(`Getting WETH balance for address: ${agentAddress}`);

      // Get WETH balance
      const balance = await rpcService.getErc20Balance(WETH_ADDRESS, agentAddress);

      // WETH has 18 decimals like regular ETH
      const formattedBalance = ethers.formatEther(balance);

      const responseContent: Content = {
        text: `Your WETH balance (${agentAddress}): ${formattedBalance} WETH`,
        actions: ['GET_WETH_BALANCE'],
        data: {
          address: agentAddress,
          tokenAddress: WETH_ADDRESS,
          balance: balance.toString(),
          formattedBalance,
          symbol: 'WETH',
          decimals: 18,
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      logger.error('Error getting WETH balance:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      const errorContent: Content = {
        text: `Error retrieving WETH balance: ${errorMessage}`,
        actions: ['GET_WETH_BALANCE'],
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
        name: 'user',
        content: {
          text: 'get my weth balance',
        },
      },
      {
        name: 'assistant',
        content: {
          text: 'Your WETH balance (0x1234...): 0.5 WETH',
          actions: ['GET_WETH_BALANCE'],
        },
      },
    ],
    [
      {
        name: 'user',
        content: {
          text: 'check me weth balance',
        },
      },
      {
        name: 'assistant',
        content: {
          text: 'Your WETH balance (0x1234...): 0.5 WETH',
          actions: ['GET_WETH_BALANCE'],
        },
      },
    ],
  ],
};

export const getERC20BalanceAction: Action = {
  name: 'POLYGON_GET_ERC20_BALANCE',
  similes: ['CHECK_TOKEN_BALANCE', 'SHOW_TOKEN_BALANCE', 'GET_TOKEN_AMOUNT'].map(
    (s) => `POLYGON_${s}`
  ),
  description: 'Gets the balance of a specified ERC20 token for the agent wallet on Polygon.',
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const content = message.content?.text?.toLowerCase() || '';

    logger.info(`[getERC20BalanceAction] VALIDATION CALLED - message: "${content}"`);

    try {
      // Check for ERC-20 token balance related keywords
      const tokenKeywords = [
        'token balance',
        'erc20 balance',
        'token amount',
        'balance of token',
        'get token balance',
        'show token balance',
        'check token balance',
      ];

      const matches = tokenKeywords.some((keyword) => content.includes(keyword));
      logger.info(`[getERC20BalanceAction] Validation result: ${matches}`);

      // Also check if we have required services
      const rpcService = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!rpcService) {
        logger.warn(`[getERC20BalanceAction] PolygonRpcService not available - validation false`);
        return false;
      }

      return matches;
    } catch (error) {
      logger.error(`[getERC20BalanceAction] Validation error:`, error);
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
    logger.info('[getERC20BalanceAction] Handler called!');

    const rpcService = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
    if (!rpcService) {
      throw new Error('PolygonRpcService not available');
    }

    try {
      // Get agent wallet address using the wallet provider
      const polygonWalletProvider = await initWalletProvider(runtime);
      if (!polygonWalletProvider) {
        throw new Error(
          'Failed to initialize PolygonWalletProvider - check that PRIVATE_KEY is configured correctly'
        );
      }
      const agentAddress = polygonWalletProvider.getAddress();
      if (!agentAddress) {
        throw new Error('Could not determine agent address from provider');
      }

      // Get token address from options (this would need to be provided)
      const tokenAddress = options?.tokenAddress as string;
      if (!tokenAddress) {
        throw new Error('Token address is required for ERC-20 balance check');
      }

      logger.info(`Getting ERC-20 balance for token: ${tokenAddress}, address: ${agentAddress}`);

      // Get token balance
      const balance = await rpcService.getErc20Balance(tokenAddress, agentAddress);

      // Format with 18 decimals as default (could be refined later)
      const formattedBalance = ethers.formatUnits(balance, 18);

      const responseContent: Content = {
        text: `Your token balance (${agentAddress}): ${formattedBalance} tokens`,
        actions: ['GET_ERC20_BALANCE'],
        data: {
          address: agentAddress,
          tokenAddress,
          balance: balance.toString(),
          formattedBalance,
          symbol: 'TOKEN',
          decimals: 18,
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      logger.error('Error getting ERC-20 balance:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      const errorContent: Content = {
        text: `Error retrieving token balance: ${errorMessage}`,
        actions: ['GET_ERC20_BALANCE'],
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
        name: 'user',
        content: {
          text: 'get token balance',
        },
      },
      {
        name: 'assistant',
        content: {
          text: 'Your TOKEN balance (0x1234...): 1,250.50 TOKEN',
          actions: ['GET_ERC20_BALANCE'],
        },
      },
    ],
  ],
};

// Legacy actions - keeping for backward compatibility but not exported
const getNativeBalanceAction: Action = {
  name: 'POLYGON_GET_NATIVE_BALANCE_LEGACY',
  description: 'Legacy action - use getMaticBalanceAction instead',
  validate: async () => false, // Disabled
  handler: async () => ({ text: 'This action is deprecated', actions: [] }),
  examples: [],
};
