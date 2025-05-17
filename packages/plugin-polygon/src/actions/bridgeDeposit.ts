/**
 * Action for bridging ERC20 tokens from Ethereum (L1) to Polygon (L2).
 * 
 * This implementation uses the Polygon bridge service to transfer tokens
 * between networks in a standardized way.
 */

import {
  type Action,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  type ActionExample,
} from '@elizaos/core';
import { PolygonBridgeService } from '../services/PolygonBridgeService.js';
import { z } from 'zod';
import { formatUnits, parseUnits } from '../utils/formatters.js';
import { PolygonRpcProvider, initPolygonRpcProvider } from '../providers/PolygonRpcProvider.js';
import { type Address } from '../types.js';
import { TIMEOUTS } from '../config.js';

interface BridgeERC20Params {
  tokenAddress: string;
  amount: string;
  recipient?: string;
}

// Template for parsing user input
const bridgeTemplate = {
  name: 'Bridge ERC20 Tokens',
  description:
    'Bridge ERC20 tokens from Ethereum (L1) to Polygon (L2) using the Polygon bridge. Respond with a valid JSON object containing the extracted parameters.',
  parameters: {
    type: 'object',
    properties: {
      tokenAddress: {
        type: 'string',
        description: 'Address of the ERC20 token on Ethereum (L1)',
      },
      amount: {
        type: 'string',
        description: 'Amount of tokens to bridge (e.g., "10.5" or "1")',
      },
      recipient: {
        type: 'string',
        description: 'Optional: Address on Polygon to receive the tokens. Defaults to sender.',
      },
    },
    required: ['tokenAddress', 'amount'],
  },
};

// Examples to help users understand how to use the action
const examples: ActionExample[] = [
  {
    input: 'Bridge 5 POL tokens to Polygon',
    output: 'Starting bridge deposit of 5 POL tokens to Polygon...',
  },
  {
    input: 'Send 1.5 USDC from Ethereum to Polygon',
    output: 'Starting bridge deposit of 1.5 USDC tokens to Polygon...',
  },
];

const bridgeOptionsSchema = z.object({
  tokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, {
    message: 'Token address must be a valid Ethereum address (0x followed by 40 hex characters)'
  }),
  amount: z.string().refine(val => {
    try {
      const num = parseFloat(val);
      return !isNaN(num) && num > 0;
    } catch (e) {
      return false;
    }
  }, {
    message: 'Amount must be a positive number'
  }),
  recipientAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, {
    message: 'Recipient address must be a valid Ethereum address (0x followed by 40 hex characters)'
  }).optional()
});

/**
 * Action to bridge ERC20 tokens from Ethereum (L1) to Polygon (L2)
 * This implementation replaces the old LiFi-based implementation with a more standardized approach.
 */
export const bridgeDepositAction: Action = {
  name: 'BRIDGE_DEPOSIT_POLYGON',
  similes: ['POLYGON_BRIDGE_FUNDS', 'MOVE_ETH_TO_POLYGON_LIFI', 'BRIDGE_TOKENS_TO_L2', 'DEPOSIT_TO_POLYGON', 'BRIDGE_ERC20_TO_POLYGON'],
  description: 'Bridge ERC20 tokens from Ethereum (L1) to Polygon (L2).',
  examples: [
    "Bridge 5 USDC from Ethereum to Polygon",
    "Transfer 0.5 DAI to my Polygon address",
    "Send 10 LINK tokens from Ethereum to Polygon address 0x1234567890abcdef1234567890abcdef12345678"
  ],
  validate: async (options: any, runtime: IAgentRuntime) => {
    try {
      // Check if required RPC URLs and private key are set
      const ethereumRpcUrl = runtime.getSetting('ETHEREUM_RPC_URL');
      const polygonRpcUrl = runtime.getSetting('POLYGON_RPC_URL');
      const privateKey = runtime.getSetting('PRIVATE_KEY');
      
      if (!ethereumRpcUrl) {
        return 'ETHEREUM_RPC_URL setting is required for bridging';
      }
      
      if (!polygonRpcUrl) {
        return 'POLYGON_RPC_URL setting is required for bridging';
      }
      
      if (!privateKey) {
        return 'PRIVATE_KEY setting is required for bridging';
      }
      
      // Check if token address and amount are provided
      if (!options?.tokenAddress) {
        return 'Token address is required for bridging';
      }
      
      if (!options?.amount) {
        return 'Amount is required for bridging';
      }
      
      // Validate options format
      try {
        bridgeOptionsSchema.parse(options);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return error.errors[0].message;
        }
        return 'Invalid bridge options format';
      }
      
      return true;
    } catch (error) {
      logger.error('Validation error:', error);
      return 'Invalid bridge options';
    }
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _o: any,
    cb: HandlerCallback | undefined,
    _rs: Memory[] | undefined
  ) => {
    logger.info('Handling BRIDGE_DEPOSIT_POLYGON for:', message.id);
    
    try {
      const { tokenAddress, amount, recipientAddress } = message.content.parameters;
      
      logger.info(`Preparing to bridge ${amount} tokens from Ethereum to Polygon`);
      logger.info(`Token address: ${tokenAddress}`);
      if (recipientAddress) {
        logger.info(`Recipient address: ${recipientAddress}`);
      }
      
      // Get the RPC provider for token metadata
      const rpcProvider = await initPolygonRpcProvider(runtime);
      if (!rpcProvider) {
        throw new Error('PolygonRpcProvider not available');
      }
      
      // Get the bridge service
      const bridgeService = runtime.getService(PolygonBridgeService.serviceType) as PolygonBridgeService;
      if (!bridgeService) {
        throw new Error('PolygonBridgeService not available');
      }
      
      // Get token metadata
      logger.info(`Fetching token metadata from Ethereum...`);
      const metadata = await rpcProvider.getErc20Metadata(tokenAddress as Address, 'L1');
      
      // Convert amount to wei based on token decimals
      const amountWei = parseUnits(amount, metadata.decimals);
      
      logger.info(`Bridging ${amount} ${metadata.symbol} (${formatUnits(amountWei, 0)} wei) to Polygon`);
      
      // Execute the bridge operation with timeout options
      logger.info(`Initiating bridge transaction...`);
      const result = await bridgeService.bridgeDeposit(
        tokenAddress as Address,
        amountWei,
        recipientAddress as Address | undefined,
        {
          approvalTimeoutMs: TIMEOUTS.APPROVAL,
          gasPriceMultiplier: 1.1, // Slight boost for faster processing
        }
      );
      
      logger.info(`Bridge transaction submitted successfully!`);
      logger.info(`Deposit transaction hash: ${result.depositTxHash}`);
      if (result.approvalTxHash) {
        logger.info(`Approval transaction hash: ${result.approvalTxHash}`);
      }
      
      // Create success message with detailed information
      const successMessage = `
Bridge deposit completed successfully!
- Token: ${metadata.symbol}
- Amount: ${amount}
- Deposit Transaction: ${result.depositTxHash}
${result.approvalTxHash ? `- Approval Transaction: ${result.approvalTxHash}` : '- No approval needed (already approved)'}
- Recipient: ${result.recipientAddress}

The tokens should appear on Polygon in approximately 20-30 minutes.
      `.trim();
      
      if (cb) {
        await cb({
          text: successMessage,
          content: { 
            success: true, 
            ...result,
            symbol: metadata.symbol,
            decimals: metadata.decimals
          },
          actions: ['BRIDGE_DEPOSIT_POLYGON'],
          source: message.content.source,
        });
      }
      
      return { 
        success: true, 
        ...result,
        symbol: metadata.symbol,
        decimals: metadata.decimals
      };
    } catch (error) {
      logger.error('Error bridging tokens:', error);
      
      // Provide a more user-friendly error message based on error type
      let userErrorMsg = `Error bridging tokens: ${error instanceof Error ? error.message : String(error)}`;
      
      if (error instanceof Error && error.message.includes('timed out')) {
        userErrorMsg = 'The approval transaction is taking longer than expected. This could be due to network congestion. You can check your wallet or block explorer for the transaction status.';
      } else if (error instanceof Error && error.message.includes('insufficient funds')) {
        userErrorMsg = 'You don\'t have enough ETH to pay for the transaction gas costs. Please add more ETH to your wallet and try again.';
      } else if (error instanceof Error && (error.message.includes('rejected') || error.message.includes('denied'))) {
        userErrorMsg = 'The transaction was rejected. Please check your wallet and try again.';
      }
      
      if (cb) {
        await cb({
          text: userErrorMsg,
          actions: ['BRIDGE_DEPOSIT_POLYGON'],
          source: message.content.source,
        });
      }
      
      return { success: false, error: userErrorMsg };
    }
  },
};
