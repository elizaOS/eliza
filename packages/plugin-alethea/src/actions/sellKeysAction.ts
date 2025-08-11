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
import { Contract, JsonRpcProvider, Wallet, formatUnits } from 'ethers';
import { sellKeysTemplate } from '../templates';
import { TRADEABLE_SHARES_ABI } from '../abis';
import { ALI_TOKEN_ADDRESS } from '../constants';

interface SellKeysParams {
  agentId: string; // ALI Agent ID (SharesContract address)
  amount: string; // Number of keys to sell
}

export const sellKeysAction: Action = {
  name: 'ALETHEA_SELL_KEYS',
  similes: ['SELL_AGENT_KEYS', 'TRADE_KEYS_FOR_ALI', 'REDEEM_KEYS'].map((s) => `ALETHEA_${s}`),
  description: 'Sell a specified number of keys for an ALI Agent, receiving ALI tokens in return.',
  validate: async () => true,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[sellKeysAction] Handler called.');
    let params: SellKeysParams | undefined;
    try {
      const prompt = composePromptFromState({
        state,
        template: sellKeysTemplate as unknown as TemplateType,
      });
      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
      const parsed = parseJSONObjectFromText(modelResponse) as SellKeysParams | { error: string };

      if ('error' in parsed) {
        logger.warn(`[sellKeysAction] Model responded with error: ${parsed.error}`);
        throw new Error(parsed.error);
      }
      params = parsed;

      const { agentId, amount } = params;
      const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL');
      const privateKey = runtime.getSetting('PRIVATE_KEY');

      if (!agentId || !amount) {
        throw new Error('ALI Agent ID (agentId) and amount of keys to sell are required.');
      }
      if (!rpcUrl || !privateKey) {
        throw new Error('ALETHEA_RPC_URL and PRIVATE_KEY are required in agent settings.');
      }
      const actualAmountToSell = BigInt(amount);
      if (actualAmountToSell <= 0n) {
        throw new Error('Amount of keys to sell must be a positive number.');
      }

      const provider = new JsonRpcProvider(rpcUrl);
      const wallet = new Wallet(privateKey, provider);
      const walletAddress = await wallet.getAddress();

      const sharesContract = new Contract(agentId, TRADEABLE_SHARES_ABI, wallet);

      logger.info(`[sellKeysAction] Checking current key balance for agent ${agentId}...`);
      const currentKeyBalance = await sharesContract.balanceOf(walletAddress);
      if (currentKeyBalance < actualAmountToSell) {
        throw new Error(
          `Insufficient key balance. You have ${currentKeyBalance.toString()} keys, but trying to sell ${amount}.`
        );
      }

      logger.info(
        `[sellKeysAction] Fetching sell price for ${amount} keys of ALI Agent ${agentId}...`
      );
      const priceForAmountBigInt = await sharesContract.getSellPriceAfterFee(actualAmountToSell);
      const priceForAmountFormatted = formatUnits(priceForAmountBigInt, 18); // Assuming 18 decimals for ALI

      logger.info(`[sellKeysAction] Selling ${amount} keys for ${priceForAmountFormatted} ALI...`);
      const sellTx = await sharesContract.sellKeys(actualAmountToSell);
      logger.info(
        `[sellKeysAction] Sell keys transaction submitted: ${sellTx.hash}. Waiting for confirmation...`
      );
      const sellReceipt = await sellTx.wait();

      if (!sellReceipt || sellReceipt.status !== 1) {
        throw new Error(`Sell keys transaction failed or was reverted. Hash: ${sellTx.hash}`);
      }
      logger.info('[sellKeysAction] Sell keys transaction confirmed.');

      const newKeyBalance = await sharesContract.balanceOf(walletAddress);
      const newKeyBalanceFormatted = newKeyBalance.toString();

      const responseText =
        `✅ **Successfully Sold Keys**\n\n` +
        `**Agent ID:** ${agentId}\n` +
        `**Keys Sold:** ${amount}\n` +
        `**Received:** ${priceForAmountFormatted} ALI tokens\n` +
        `**Transaction Hash:** ${sellTx.hash}\n` +
        `**Your New Key Balance:** ${newKeyBalanceFormatted} keys\n\n` +
        `🔗 **View Transaction:** https://basescan.org/tx/${sellTx.hash}`;

      const responseContent: Content = {
        text: responseText,
        data: {
          agentId,
          amountSold: amount,
          receivedAliTokenSmallestUnit: priceForAmountBigInt.toString(),
          receivedAliTokenFormatted: priceForAmountFormatted,
          txHash: sellTx.hash,
          newKeyBalance: newKeyBalanceFormatted,
          blockNumber: sellReceipt.blockNumber,
          gasUsed: sellReceipt.gasUsed.toString(),
          timestamp: new Date().toISOString(),
        },
      };
      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[sellKeysAction] Error:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error during key sale.';
      const errorContent: Content = {
        text: `❌ **Error selling keys**: ${errorMessage}`,
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
        content: { text: 'Sell 10 keys for ALI agent 0xagentId123...xyz via Alethea.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Okay, attempting to sell 10 keys for agent 0xagentId123...xyz via Alethea. I will first check your balance and the current sell price.',
          actions: ['ALETHEA_SELL_KEYS'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'I want to sell 1 key of agent 0xanotherAgentID via Alethea.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Understood. Selling 1 key for agent 0xanotherAgentID via Alethea.',
          actions: ['ALETHEA_SELL_KEYS'],
        },
      },
    ],
  ],
};
