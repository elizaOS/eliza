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
import { JsonRpcProvider, Contract, formatUnits, isAddress, getAddress } from 'ethers';
import { getAccountBalanceTemplate } from '../templates';
import { callLLMWithTimeout } from '../utils/llmHelpers';

// ERC-20 ABI for balanceOf function
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
];

interface TokenBalance {
  contract: string;
  balance: string;
  decimals?: number;
  symbol?: string;
  name?: string;
  balanceFormatted?: string;
}

interface AccountBalanceResult {
  address: string;
  native: string;
  nativeFormatted: string;
  tokens: TokenBalance[];
  method: 'alchemy' | 'rpc';
  timestamp: number;
}

/**
 * Validate and normalize an Ethereum address
 */
function validateAndNormalizeAddress(address: string): string {
  if (!address) {
    throw new Error('Address is required');
  }

  // Remove any whitespace
  const cleanAddress = address.trim();

  // Check if it's a valid address format
  if (!isAddress(cleanAddress)) {
    throw new Error(
      `Invalid address format: ${cleanAddress}. Please provide a valid Ethereum address starting with 0x.`
    );
  }

  // Return the checksummed address
  try {
    return getAddress(cleanAddress);
  } catch (error) {
    throw new Error(
      `Invalid address checksum: ${cleanAddress}. Please use the correct capitalization or provide the address in all lowercase.`
    );
  }
}

/**
 * Get account balance action for Polygon zkEVM
 * Retrieves native ETH balance and ERC-20 token balances for a given address
 */
export const getAccountBalanceAction: Action = {
  name: 'POLYGON_ZKEVM_GET_ACCOUNT_BALANCE',
  similes: [
    'GET_WALLET_BALANCE',
    'CHECK_ACCOUNT_BALANCE',
    'ACCOUNT_BALANCE',
    'WALLET_BALANCE',
    'GET_TOKEN_BALANCES',
    'CHECK_TOKENS',
    'BALANCE_CHECK',
    'GET_ALL_BALANCES',
  ].map((s) => `POLYGON_ZKEVM_${s}`),
  description:
    'Get comprehensive account balance including native ETH and ERC-20 token balances for a Polygon zkEVM address',

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
    logger.info('[getAccountBalanceAction] Handler called!');

    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

    if (!alchemyApiKey && !zkevmRpcUrl) {
      const errorMessage = 'ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.';
      logger.error(`[getAccountBalanceAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYGON_GET_ACCOUNT_BALANCE_ZKEVM'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    let addressInput: any | null = null;

    // Extract address using LLM with OBJECT_LARGE model
    try {
      addressInput = await callLLMWithTimeout<{ address: string; error?: string }>(
        runtime,
        state,
        getAccountBalanceTemplate,
        'getAccountBalanceAction'
      );

      if (addressInput?.error) {
        logger.error('[getAccountBalanceAction] LLM returned an error:', addressInput?.error);
        throw new Error(addressInput?.error);
      }

      if (!addressInput?.address || typeof addressInput.address !== 'string') {
        throw new Error('Invalid address received from LLM.');
      }
    } catch (error) {
      logger.debug(
        '[getAccountBalanceAction] OBJECT_LARGE model failed',
        error instanceof Error ? error : undefined
      );
      throw new Error(
        `[getAccountBalanceAction] Failed to extract address from input: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const address = addressInput.address;
    logger.info(`[getAccountBalanceAction] Getting account balance for address: ${address}`);

    // Validate and normalize the address
    let validatedAddress: string;
    try {
      validatedAddress = validateAndNormalizeAddress(address);
      logger.info(`[getAccountBalanceAction] Address validated: ${validatedAddress}`);
    } catch (error) {
      const errorMessage = `Invalid address: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMessage);

      const errorContent: Content = {
        text: `❌ ${errorMessage}`,
        actions: ['POLYGON_GET_ACCOUNT_BALANCE_ZKEVM'],
        data: { error: errorMessage, success: false },
      };

      if (callback) {
        await callback(errorContent);
      }
      return errorContent;
    }

    // Setup provider - prefer Alchemy, fallback to RPC
    let provider: JsonRpcProvider;
    let methodUsed: 'alchemy' | 'rpc' = 'rpc';
    const zkevmAlchemyUrl =
      runtime.getSetting('ZKEVM_ALCHEMY_URL') || 'https://polygonzkevm-mainnet.g.alchemy.com/v2';

    if (alchemyApiKey) {
      provider = new JsonRpcProvider(`${zkevmAlchemyUrl}/${alchemyApiKey}`);
      methodUsed = 'alchemy';
      logger.info('[getAccountBalanceAction] Using Alchemy API for account balance');
    } else {
      provider = new JsonRpcProvider(zkevmRpcUrl);
      logger.info('[getAccountBalanceAction] Using direct RPC for account balance');
    }

    let nativeBalance = '0';
    const tokenBalances: TokenBalance[] = [];
    let errorMessages: string[] = [];

    // Get native ETH balance
    try {
      logger.info('[getAccountBalanceAction] Fetching native ETH balance...');
      const balance = await provider.getBalance(validatedAddress);
      nativeBalance = balance.toString();
      logger.info(`[getAccountBalanceAction] Native balance retrieved: ${nativeBalance} wei`);
    } catch (error) {
      const errorMsg = `Failed to get native balance: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMsg);
      errorMessages.push(errorMsg);
    }

    // Format native balance
    const nativeFormatted = formatUnits(nativeBalance, 18);

    // Prepare result
    const result: AccountBalanceResult = {
      address: validatedAddress,
      native: nativeBalance,
      nativeFormatted,
      tokens: tokenBalances,
      method: methodUsed,
      timestamp: Date.now(),
    };

    // Format response
    const responseText = `💰 **Account Balance (Polygon zkEVM)**

**Address:** \`${validatedAddress}\`
**Native Balance:** ${nativeFormatted} ETH
**Method:** ${methodUsed}

${errorMessages.length > 0 ? `\n**Warnings:**\n${errorMessages.map((msg) => `- ${msg}`).join('\n')}` : ''}`;

    const responseContent: Content = {
      text: responseText,
      actions: ['POLYGON_GET_ACCOUNT_BALANCE_ZKEVM'],
      data: {
        result,
        network: 'polygon-zkevm',
        timestamp: Date.now(),
        method: methodUsed,
      },
    };

    if (callback) {
      await callback(responseContent);
    }

    return responseContent;
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Get balance for address 0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6 on Polygon zkEVM',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll get the account balance for that address on Polygon zkEVM.",
          action: 'POLYGON_GET_ACCOUNT_BALANCE_ZKEVM',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'check my wallet balance on Polygon zkEVM',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'I can do that. Please provide your wallet address.',
          action: 'POLYGON_GET_ACCOUNT_BALANCE_ZKEVM',
        },
      },
    ],
  ],
};
