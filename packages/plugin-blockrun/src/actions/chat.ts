import {
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from '@elizaos/core';
import { LLMClient, type ChatOptions } from '@blockrun/llm';

/**
 * BlockRun Chat Action - Pay-per-request AI via x402 micropayments on Base.
 *
 * This action enables ElizaOS agents to make LLM API calls using the x402 protocol,
 * paying with USDC on Base chain. Supports OpenAI, Anthropic, Google, and other models.
 */

// Cache client instances per agent to avoid recreating
const clientCache = new Map<string, LLMClient>();

function getClient(runtime: IAgentRuntime): LLMClient {
  const agentId = runtime.agentId;

  if (clientCache.has(agentId)) {
    return clientCache.get(agentId)!;
  }

  // Get private key from runtime settings or environment
  const privateKey = runtime.getSetting('BASE_CHAIN_WALLET_KEY') ||
    runtime.getSetting('BLOCKRUN_WALLET_KEY') ||
    process.env.BASE_CHAIN_WALLET_KEY;

  if (!privateKey) {
    throw new Error(
      'BlockRun requires a wallet private key. Set BASE_CHAIN_WALLET_KEY in agent settings or environment.'
    );
  }

  const apiUrl = runtime.getSetting('BLOCKRUN_API_URL') || 'https://blockrun.ai/api';

  const client = new LLMClient({
    privateKey: privateKey as `0x${string}`,
    apiUrl,
  });

  clientCache.set(agentId, client);
  return client;
}

export const blockrunChatAction: Action = {
  name: 'BLOCKRUN_CHAT',
  similes: ['BLOCKRUN_AI', 'PAY_PER_REQUEST', 'X402_CHAT', 'MICROPAY_AI'],
  description:
    'Make a pay-per-request AI call using BlockRun x402 protocol. ' +
    'Automatically handles micropayments in USDC on Base chain. ' +
    'Supports multiple AI providers: OpenAI (gpt-4o, gpt-4o-mini), Anthropic (claude-sonnet-4, claude-3.5-haiku), Google (gemini-2.0-flash), and more.',

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    try {
      const privateKey = runtime.getSetting('BASE_CHAIN_WALLET_KEY') ||
        runtime.getSetting('BLOCKRUN_WALLET_KEY') ||
        process.env.BASE_CHAIN_WALLET_KEY;

      if (!privateKey) {
        logger.warn({
          src: 'plugin:blockrun:action:chat',
          agentId: runtime.agentId,
        }, 'BlockRun wallet key not configured');
        return false;
      }

      return true;
    } catch (error) {
      logger.error({
        src: 'plugin:blockrun:action:chat',
        error: error instanceof Error ? error.message : String(error),
      }, 'Error validating BlockRun action');
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const startTime = Date.now();

    try {
      const client = getClient(runtime);

      // Extract the prompt from the message
      const prompt = message.content?.text || '';
      if (!prompt) {
        return {
          text: 'No prompt provided for BlockRun chat',
          values: { success: false, error: 'No prompt' },
          data: { actionName: 'BLOCKRUN_CHAT' },
          success: false,
        };
      }

      // Get model from options or use default
      const model = (options as Record<string, unknown>)?.model as string ||
        runtime.getSetting('BLOCKRUN_DEFAULT_MODEL') ||
        'openai/gpt-4o-mini';

      // Get system prompt from character or options
      const systemPrompt = (options as Record<string, unknown>)?.system as string ||
        runtime.character?.system ||
        undefined;

      // Build chat options
      const chatOptions: ChatOptions = {
        system: systemPrompt,
        maxTokens: (options as Record<string, unknown>)?.maxTokens as number || 1024,
        temperature: (options as Record<string, unknown>)?.temperature as number,
      };

      logger.info({
        src: 'plugin:blockrun:action:chat',
        agentId: runtime.agentId,
        model,
        promptLength: prompt.length,
      }, 'Making BlockRun API call');

      // Make the pay-per-request call
      const response = await client.chat(model, prompt, chatOptions);

      const latency = Date.now() - startTime;

      logger.info({
        src: 'plugin:blockrun:action:chat',
        agentId: runtime.agentId,
        model,
        responseLength: response.length,
        latencyMs: latency,
      }, 'BlockRun call completed');

      // Send response via callback if provided
      if (callback) {
        await callback({
          text: response,
          actions: ['BLOCKRUN_CHAT'],
        });
      }

      return {
        text: response,
        values: {
          success: true,
          model,
          responseLength: response.length,
          latencyMs: latency,
          walletAddress: client.getWalletAddress(),
        },
        data: {
          actionName: 'BLOCKRUN_CHAT',
          model,
          prompt,
          response,
          latencyMs: latency,
        },
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error({
        src: 'plugin:blockrun:action:chat',
        agentId: runtime.agentId,
        error: errorMessage,
      }, 'BlockRun chat failed');

      return {
        text: `BlockRun error: ${errorMessage}`,
        values: {
          success: false,
          error: errorMessage,
        },
        data: {
          actionName: 'BLOCKRUN_CHAT',
          error: errorMessage,
        },
        success: false,
        error: error instanceof Error ? error : new Error(errorMessage),
      };
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Ask BlockRun AI: What is the capital of France?',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'The capital of France is Paris.',
          actions: ['BLOCKRUN_CHAT'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Use x402 to query: Explain smart contracts in one sentence.',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Smart contracts are self-executing programs on a blockchain that automatically enforce agreement terms when conditions are met.',
          actions: ['BLOCKRUN_CHAT'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Pay-per-request: Generate a haiku about crypto payments.',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Digital coins flow\nMicropayments stream like rain\nValue finds its way',
          actions: ['BLOCKRUN_CHAT'],
        },
      },
    ],
  ] as ActionExample[][],
};

export default blockrunChatAction;
