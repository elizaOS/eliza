import { type Action, logger, type IAgentRuntime } from '@elizaos/core';
import { z } from 'zod';
import { formatUnits, normalizeAddress } from '../utils/formatters.js';
import { PolygonRpcService } from '../services/PolygonRpcService.js';
import { type Address } from '../types.js';

const balanceOptionsSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, {
    message: 'Address must be a valid Ethereum address (0x followed by 40 hex characters)'
  }),
  tokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, {
    message: 'Token address must be a valid Ethereum address (0x followed by 40 hex characters)'
  }).optional()
});

/**
 * Action to get native MATIC balance for an address on Polygon (L2)
 */
export const getNativeBalanceAction: Action = {
  name: 'GET_NATIVE_BALANCE',
  description: 'Gets the native MATIC balance for an address on Polygon (L2).',
  
  // Define examples
  examples: [
    "What's my MATIC balance on Polygon?",
    "Show me the balance for address 0x1234567890abcdef1234567890abcdef12345678",
    "How much MATIC does 0x1234567890abcdef1234567890abcdef12345678 have?"
  ],
  
  validate: async (options: any, runtime: IAgentRuntime) => {
    try {
      // Check if POLYGON_RPC_URL is set in environment
      const polygonRpcUrl = runtime.getSetting('POLYGON_RPC_URL');
      if (!polygonRpcUrl) {
        return 'POLYGON_RPC_URL setting is required to get balance information';
      }
      
      // If no address provided, check if we have a default address
      if (!options?.address) {
        const defaultAddress = runtime.getSetting('DEFAULT_ADDRESS');
        if (!defaultAddress) {
          return 'Address is required to get balance';
        }
      }
      
      // If address is provided, validate format
      if (options?.address) {
        try {
          balanceOptionsSchema.parse({ address: options.address });
        } catch (error) {
          if (error instanceof z.ZodError) {
            return error.errors[0].message;
          }
          return 'Invalid address format';
        }
      }
      
      return true;
    } catch (error) {
      logger.error('Validation error:', error);
      return 'Invalid balance options';
    }
  },
  
  execute: async (options: any, runtime: IAgentRuntime) => {
    try {
      // Get address from options or default
      let address = options?.address as Address;
      if (!address) {
        address = runtime.getSetting('DEFAULT_ADDRESS') as Address;
        logger.info(`Using default address: ${address}`);
      } else {
        logger.info(`Getting native balance for address: ${address}`);
      }
      
      // Get the RPC service
      const rpcService = runtime.getService(PolygonRpcService.serviceType) as PolygonRpcService;
      if (!rpcService) {
        throw new Error('PolygonRpcService not available');
      }
      
      // Get native balance
      logger.info(`Fetching MATIC balance for ${address}`);
      const balance = await rpcService.getNativeBalance(address);
      
      // Format the balance
      const formattedBalance = formatUnits(balance, 18);
      
      logger.info(`MATIC balance: ${formattedBalance} MATIC`);
      
      return {
        actions: ['GET_NATIVE_BALANCE'],
        data: {
          address,
          balance: balance.toString(),
          formattedBalance,
          symbol: 'MATIC'
        }
      };
    } catch (error) {
      logger.error('Error getting native balance:', error);
      return {
        actions: ['GET_NATIVE_BALANCE'],
        data: { error: error instanceof Error ? error.message : String(error) }
      };
    }
  },
};

/**
 * Action to get ERC20 token balance for an address on Polygon (L2)
 */
export const getERC20BalanceAction: Action = {
  name: 'GET_ERC20_BALANCE',
  description: 'Gets the ERC20 token balance for an address on Polygon (L2).',
  
  // Define examples
  examples: [
    "What's my USDC balance on Polygon?",
    "Show me the token balance for address 0x1234567890abcdef1234567890abcdef12345678 and token 0xabcdef1234567890abcdef1234567890abcdef12",
    "How many tokens does 0x1234567890abcdef1234567890abcdef12345678 have for contract 0xabcdef1234567890abcdef1234567890abcdef12?"
  ],
  
  validate: async (options: any, runtime: IAgentRuntime) => {
    try {
      // Check if POLYGON_RPC_URL is set in environment
      const polygonRpcUrl = runtime.getSetting('POLYGON_RPC_URL');
      if (!polygonRpcUrl) {
        return 'POLYGON_RPC_URL setting is required to get token balance';
      }
      
      // Check if token address is provided
      if (!options?.tokenAddress) {
        return 'Token address is required to get ERC20 balance';
      }
      
      // If no address provided, check if we have a default address
      if (!options?.address) {
        const defaultAddress = runtime.getSetting('DEFAULT_ADDRESS');
        if (!defaultAddress) {
          return 'Address is required to get token balance';
        }
      }
      
      // Validate options format
      try {
        balanceOptionsSchema.parse({
          address: options.address || runtime.getSetting('DEFAULT_ADDRESS'),
          tokenAddress: options.tokenAddress
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return error.errors[0].message;
        }
        return 'Invalid address or token address format';
      }
      
      return true;
    } catch (error) {
      logger.error('Validation error:', error);
      return 'Invalid token balance options';
    }
  },
  
  execute: async (options: any, runtime: IAgentRuntime) => {
    try {
      // Get addresses from options or default
      let address = options?.address as Address;
      if (!address) {
        address = runtime.getSetting('DEFAULT_ADDRESS') as Address;
        logger.info(`Using default address: ${address}`);
      }
      
      const tokenAddress = options.tokenAddress as Address;
      
      logger.info(`Getting token balance for address: ${address}, token: ${tokenAddress}`);
      
      // Get the RPC service
      const rpcService = runtime.getService(PolygonRpcService.serviceType) as PolygonRpcService;
      if (!rpcService) {
        throw new Error('PolygonRpcService not available');
      }
      
      // Get token metadata and balance in parallel
      logger.info(`Fetching token metadata and balance...`);
      const [metadata, balance] = await Promise.all([
        rpcService.getErc20Metadata(tokenAddress, 'L2'),
        rpcService.getErc20Balance(tokenAddress, address, 'L2')
      ]);
      
      // Format the balance
      const formattedBalance = formatUnits(balance, metadata.decimals);
      
      logger.info(`Token balance: ${formattedBalance} ${metadata.symbol}`);
      
      return {
        actions: ['GET_ERC20_BALANCE'],
        data: {
          address,
          tokenAddress,
          symbol: metadata.symbol,
          decimals: metadata.decimals,
          balance: balance.toString(),
          formattedBalance
        }
      };
    } catch (error) {
      logger.error('Error getting token balance:', error);
      return {
        actions: ['GET_ERC20_BALANCE'],
        data: { error: error instanceof Error ? error.message : String(error) }
      };
    }
  },
}; 