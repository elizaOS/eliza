import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  composePromptFromState,
  ModelType,
  type TemplateType,
  parseJSONObjectFromText,
} from '@elizaos/core';
import { Contract, JsonRpcProvider, formatUnits } from 'ethers';
import { getAliAgentKeySellPriceTemplate } from '../templates';
import { TRADEABLE_SHARES_ABI } from '../abis';
import { ALI_TOKEN_ADDRESS } from '../constants';

interface GetAliAgentKeySellPriceParams {
  agentId: string;
  amount: string; // Number of keys, defaults to "1"
}

export const getAliAgentKeySellPriceAction: Action = {
  name: 'ALETHEA_GET_ALI_AGENT_KEY_SELL_PRICE',
  similes: ['FETCH_KEY_SELL_PRICE', 'GET_SELL_PRICE', 'HOW_MUCH_FOR_SELLING_KEYS'].map(
    (s) => `ALETHEA_${s}`
  ),
  description:
    'Get the current sell price for a specified amount of Keys of an ALI Agent (price is for the total amount in ALI token).',
  validate: async () => true,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getAliAgentKeySellPriceAction] Handler called.');
    let params: GetAliAgentKeySellPriceParams | undefined;
    try {
      const prompt = composePromptFromState({
        state,
        template: getAliAgentKeySellPriceTemplate as unknown as TemplateType,
      });
      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
      const parsed = parseJSONObjectFromText(modelResponse) as
        | GetAliAgentKeySellPriceParams
        | { error: string };

      if ('error' in parsed) {
        logger.warn(`[getAliAgentKeySellPriceAction] Model responded with error: ${parsed.error}`);
        throw new Error(parsed.error);
      }
      params = parsed;

      const { agentId, amount = '1' } = params;
      const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL');

      if (!agentId) {
        throw new Error('ALI Agent ID (agentId) is required.');
      }
      if (!rpcUrl) {
        throw new Error('ALETHEA_RPC_URL is required in agent settings.');
      }
      if (isNaN(parseInt(amount)) || parseInt(amount) <= 0) {
        throw new Error('Amount of keys must be a positive number.');
      }

      const provider = new JsonRpcProvider(rpcUrl);
      const sharesContract = new Contract(agentId, TRADEABLE_SHARES_ABI, provider);

      logger.info(
        `[getAliAgentKeySellPriceAction] Fetching sell price for ${amount} keys of ALI Agent ${agentId}...`
      );
      const sellPriceBigInt = await sharesContract.getSellPriceAfterFee(BigInt(amount));
      const sellPriceFormatted = formatUnits(sellPriceBigInt, 18); // Assuming 18 decimals for ALI token

      const responseText =
        `💰 **ALI Agent Key Sell Price**\n\n` +
        `**Agent ID:** ${agentId}\n` +
        `**Amount of Keys:** ${amount}\n` +
        `**Total Sell Price (You Receive):** ${sellPriceFormatted} ALI tokens\n` +
        `(Raw value: ${sellPriceBigInt.toString()} smallest units of ALI token)\n\n` +
        `ℹ️ This is the total amount in ALI tokens you would receive for selling ${amount} key(s). The tokens are ${ALI_TOKEN_ADDRESS}.`;

      const responseContent: Content = {
        text: responseText,
        data: {
          agentId,
          amount,
          sellPrice: sellPriceBigInt.toString(),
          sellPriceFormatted,
          receiveTokenAddress: ALI_TOKEN_ADDRESS,
          receiveTokenDecimalsAssumption: 18,
          timestamp: new Date().toISOString(),
        },
      };
      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[getAliAgentKeySellPriceAction] Error:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error fetching key sell price.';
      const errorContent: Content = {
        text: `❌ **Error fetching ALI Agent key sell price**: ${errorMessage}`,
        data: {
          error: errorMessage,
          agentId: params?.agentId,
          amount: params?.amount,
          timestamp: new Date().toISOString(),
        },
      };
      if (callback) await callback(errorContent);
      throw error;
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'How much will I get for selling 1 key of agent 0x123...abc via Alethea?',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching sell price via Alethea...',
          actions: ['ALETHEA_GET_ALI_AGENT_KEY_SELL_PRICE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Get sell price for 5 keys of ALI agent 0xdef...456 via Alethea.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Sure, let me check the sell price via Alethea.',
          actions: ['ALETHEA_GET_ALI_AGENT_KEY_SELL_PRICE'],
        },
      },
    ],
  ],
};
