import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  ProviderResult,
  State,
} from '@elizaos/core';
import { logger } from '@elizaos/core';
import { z } from 'zod';
import { execSync } from 'child_process';

const configSchema = z.object({
  PRIVATE_KEY: z
    .string()
    .min(1, 'PRIVATE_KEY is required for Mint Club wallet operations'),
});

function runMcCommand(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 30000 }).trim();
  } catch (error: any) {
    const stderr = error.stderr?.toString() || error.message;
    throw new Error(`mc command failed: ${stderr}`);
  }
}

// --- Actions ---

const tokenInfoAction: Action = {
  name: 'TOKEN_INFO',
  similes: ['GET_TOKEN_INFO', 'MINT_CLUB_INFO', 'MC_INFO'],
  description: 'Get information about a Mint Club V2 token',

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const text = message.content.text || '';
    return /\b(info|details|about)\b/i.test(text) && text.trim().split(/\s+/).length >= 2;
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: any,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const text = message.content.text || '';
      const words = text.trim().split(/\s+/);
      const token = words[words.length - 1];
      const result = runMcCommand(`mc info ${token}`);

      if (callback) {
        await callback({
          text: result,
          actions: ['TOKEN_INFO'],
          source: message.content.source,
        });
      }

      return { text: result, success: true };
    } catch (error) {
      logger.error({ error }, 'Error in TOKEN_INFO action');
      return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  },

  examples: [
    [
      { name: '{{userName}}', content: { text: 'Get info about MINT', actions: [] } },
      { name: '{{agentName}}', content: { text: 'Here is the token info for MINT...', actions: ['TOKEN_INFO'] } },
    ],
  ],
};

const tokenPriceAction: Action = {
  name: 'TOKEN_PRICE',
  similes: ['GET_PRICE', 'MINT_CLUB_PRICE', 'MC_PRICE', 'CHECK_PRICE'],
  description: 'Get the current price of a Mint Club V2 token',

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const text = message.content.text || '';
    return /\b(price|cost|value|worth)\b/i.test(text);
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: any,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const text = message.content.text || '';
      const words = text.trim().split(/\s+/);
      const token = words[words.length - 1];
      const result = runMcCommand(`mc price ${token}`);

      if (callback) {
        await callback({
          text: result,
          actions: ['TOKEN_PRICE'],
          source: message.content.source,
        });
      }

      return { text: result, success: true };
    } catch (error) {
      logger.error({ error }, 'Error in TOKEN_PRICE action');
      return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  },

  examples: [
    [
      { name: '{{userName}}', content: { text: 'What is the price of MINT?', actions: [] } },
      { name: '{{agentName}}', content: { text: 'The current price of MINT is...', actions: ['TOKEN_PRICE'] } },
    ],
  ],
};

const swapAction: Action = {
  name: 'SWAP',
  similes: ['TRADE', 'EXCHANGE', 'MINT_CLUB_SWAP', 'MC_SWAP', 'BUY', 'SELL'],
  description: 'Swap tokens using Mint Club V2 bonding curves',

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const text = message.content.text || '';
    return /\b(swap|trade|exchange|buy|sell)\b/i.test(text);
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: any,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const text = message.content.text || '';

      // Extract input token, output token, and amount from message
      const inputMatch = text.match(/(?:from|input|sell)\s+(\S+)/i);
      const outputMatch = text.match(/(?:to|output|for|buy)\s+(\S+)/i);
      const amountMatch = text.match(/(\d+(?:\.\d+)?)\s*/);

      if (!inputMatch || !outputMatch || !amountMatch) {
        const errMsg = 'Please specify input token, output token, and amount. Example: "swap 100 from ETH to MINT"';
        if (callback) {
          await callback({ text: errMsg, actions: ['SWAP'], source: message.content.source });
        }
        return { text: errMsg, success: false, error: new Error('Missing swap parameters') };
      }

      const input = inputMatch[1];
      const output = outputMatch[1];
      const amount = amountMatch[1];

      const result = runMcCommand(`mc swap -i ${input} -o ${output} -a ${amount}`);

      if (callback) {
        await callback({
          text: result,
          actions: ['SWAP'],
          source: message.content.source,
        });
      }

      return { text: result, success: true };
    } catch (error) {
      logger.error({ error }, 'Error in SWAP action');
      return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  },

  examples: [
    [
      { name: '{{userName}}', content: { text: 'Swap 100 from ETH to MINT', actions: [] } },
      { name: '{{agentName}}', content: { text: 'Swapping 100 ETH to MINT...', actions: ['SWAP'] } },
    ],
  ],
};

const walletBalanceAction: Action = {
  name: 'WALLET_BALANCE',
  similes: ['CHECK_BALANCE', 'MY_WALLET', 'MC_WALLET', 'BALANCES'],
  description: 'Get wallet balances for the configured Mint Club wallet',

  validate: async (_runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
    return true;
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: any,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const result = runMcCommand('mc wallet');

      if (callback) {
        await callback({
          text: result,
          actions: ['WALLET_BALANCE'],
          source: message.content.source,
        });
      }

      return { text: result, success: true };
    } catch (error) {
      logger.error({ error }, 'Error in WALLET_BALANCE action');
      return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  },

  examples: [
    [
      { name: '{{userName}}', content: { text: 'Show my wallet balance', actions: [] } },
      { name: '{{agentName}}', content: { text: 'Here are your wallet balances...', actions: ['WALLET_BALANCE'] } },
    ],
  ],
};

// --- Provider ---

const mintclubProvider: Provider = {
  name: 'MINTCLUB_PROVIDER',
  description: 'Provides context about available Mint Club V2 commands and capabilities',

  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    return {
      text: [
        'Mint Club V2 is a bonding curve token platform. Available commands:',
        '- TOKEN_INFO: Get detailed info about a token (mc info <token>)',
        '- TOKEN_PRICE: Get current price of a token (mc price <token>)',
        '- SWAP: Swap tokens via bonding curves (mc swap -i <input> -o <output> -a <amount>)',
        '- WALLET_BALANCE: Check wallet balances (mc wallet)',
        '',
        'The mc CLI (mint.club-cli) must be installed and configured with a PRIVATE_KEY.',
      ].join('\n'),
      values: {
        platform: 'Mint Club V2',
        cli: 'mint.club-cli',
      },
      data: {},
    };
  },
};

// --- Plugin ---

export const mintclubPlugin: Plugin = {
  name: 'plugin-mintclub',
  description: 'Mint Club V2 plugin for ElizaOS — token info, pricing, swaps, and wallet management via the mc CLI',
  config: {
    PRIVATE_KEY: process.env.PRIVATE_KEY,
  },
  async init(config: Record<string, string>) {
    logger.info('Initializing Mint Club V2 plugin');
    try {
      const validatedConfig = await configSchema.parseAsync(config);
      for (const [key, value] of Object.entries(validatedConfig)) {
        if (value) process.env[key] = value;
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessages = error.issues?.map((e) => e.message)?.join(', ') || 'Unknown validation error';
        throw new Error(`Invalid plugin configuration: ${errorMessages}`);
      }
      throw new Error(
        `Invalid plugin configuration: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
  actions: [tokenInfoAction, tokenPriceAction, swapAction, walletBalanceAction],
  providers: [mintclubProvider],
};

export default mintclubPlugin;
