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
import { getAliAgentKeyBuyPriceTemplate } from '../templates';
import { TRADEABLE_SHARES_ABI } from '../abis';
import { ALI_TOKEN_ADDRESS } from '../constants'; // To inform user about payment token

// Interface for GetAliAgentKeyBuyPrice parameters
interface GetAliAgentKeyBuyPriceParams {
  agentId: string;
  amount: string; // Number of keys, defaults to "1"
}

export const getAliAgentKeyBuyPriceAction: Action = {
  name: 'ALETHEA_GET_ALI_AGENT_KEY_BUY_PRICE',
  similes: ['FETCH_KEY_BUY_PRICE', 'GET_BUY_PRICE', 'HOW_MUCH_TO_BUY_KEYS'].map(
    (s) => `ALETHEA_${s}`
  ),
  description:
    'Get the current buy price of a specified amount of Keys for an ALI Agent (price is for the total amount in ALI token).',
  validate: async () => true,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getAliAgentKeyBuyPriceAction] Handler called.');
    let params: GetAliAgentKeyBuyPriceParams | undefined;
    try {
      const prompt = composePromptFromState({
        state,
        template: getAliAgentKeyBuyPriceTemplate as unknown as TemplateType,
      });
      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
      const parsed = parseJSONObjectFromText(modelResponse) as
        | GetAliAgentKeyBuyPriceParams
        | { error: string };

      if ('error' in parsed) {
        logger.warn(`[getAliAgentKeyBuyPriceAction] Model responded with error: ${parsed.error}`);
        throw new Error(parsed.error);
      }
      params = parsed;

      const { agentId, amount = '1' } = params; // Default amount to 1 key
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
        `[getAliAgentKeyBuyPriceAction] Fetching buy price for ${amount} keys of ALI Agent ${agentId}...`
      );
      const buyPriceBigInt = await sharesContract.getBuyPriceAfterFee(BigInt(amount));
      const buyPriceFormatted = formatUnits(buyPriceBigInt, 18);

      const responseText =
        `💰 **ALI Agent Key Buy Price**\n\n` +
        `**Agent ID:** ${agentId}\n` +
        `**Amount of Keys:** ${amount}\n` +
        `**Total Buy Price:** ${buyPriceFormatted} ALI tokens\n` +
        `(Raw value: ${buyPriceBigInt.toString()} smallest units of ALI token)\n\n` +
        `ℹ️ This is the total price in ALI tokens to buy ${amount} key(s). Payment is made in ALI token (${ALI_TOKEN_ADDRESS}).`;

      const responseContent: Content = {
        text: responseText,
        data: {
          agentId,
          amount,
          buyPrice: buyPriceBigInt.toString(),
          buyPriceFormatted,
          paymentTokenAddress: ALI_TOKEN_ADDRESS,
          paymentTokenDecimalsAssumption: 18,
          timestamp: new Date().toISOString(),
        },
      };
      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[getAliAgentKeyBuyPriceAction] Error:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error fetching key buy price.';
      const errorContent: Content = {
        text: `❌ **Error fetching ALI Agent key buy price**: ${errorMessage}`,
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
        content: { text: 'How much does it cost to buy 1 key for agent 0x123...abc via Alethea?' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching buy price via Alethea...',
          actions: ['ALETHEA_GET_ALI_AGENT_KEY_BUY_PRICE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Get buy price for 10 keys of ALI agent 0xdef...456 via Alethea.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Sure, getting that price for you via Alethea.',
          actions: ['ALETHEA_GET_ALI_AGENT_KEY_BUY_PRICE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: "What's the buy price for agent 0xaaaa...cccc for 5 keys via Alethea" },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me check the price for 5 keys of agent 0xaaaa...cccc via Alethea.',
          actions: ['ALETHEA_GET_ALI_AGENT_KEY_BUY_PRICE'],
        },
      },
    ],
  ],
};
