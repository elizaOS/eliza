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
import { Contract, JsonRpcProvider, Wallet, MaxUint256, formatUnits, parseUnits } from 'ethers';
import { buyKeysTemplate } from '../templates';
import { TRADEABLE_SHARES_ABI, ALI_TOKEN_ERC20_ABI } from '../abis';
import { ALI_TOKEN_ADDRESS } from '../constants';

interface BuyKeysParams {
  agentId: string; // ALI Agent ID (SharesContract address)
  amount: string; // Number of keys to purchase
}

export const buyKeysAction: Action = {
  name: 'ALETHEA_BUY_KEYS',
  similes: ['PURCHASE_KEYS', 'ACQUIRE_KEYS', 'BUY_AGENT_KEYS'].map((s) => `ALETHEA_${s}`),
  description:
    'Buy a specified number of keys for an ALI Agent. Requires prior approval of ALI tokens.',
  validate: async () => true,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[buyKeysAction] Handler called.');
    let params: BuyKeysParams | undefined;
    let rpcUrl: string | undefined;
    let privateKey: string | undefined;
    let sharesContract: Contract | undefined;
    let aliTokenContract: Contract | undefined;
    let wallet: Wallet | undefined;
    let walletAddress: string | undefined;
    let actualAmountToBuy: bigint | undefined;

    try {
      const prompt = composePromptFromState({
        state,
        template: buyKeysTemplate as unknown as TemplateType,
      });
      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
      const parsed = parseJSONObjectFromText(modelResponse) as BuyKeysParams | { error: string };

      if ('error' in parsed) {
        logger.warn(`[buyKeysAction] Model responded with error: ${parsed.error}`);
        throw new Error(parsed.error);
      }
      params = parsed;

      const { agentId, amount } = params;
      rpcUrl = runtime.getSetting('ALETHEA_RPC_URL');
      privateKey = runtime.getSetting('PRIVATE_KEY');

      if (!agentId || !amount) {
        throw new Error('ALI Agent ID (agentId) and amount of keys are required.');
      }
      if (!rpcUrl || !privateKey) {
        throw new Error('ALETHEA_RPC_URL and PRIVATE_KEY are required in agent settings.');
      }
      actualAmountToBuy = BigInt(amount);
      if (actualAmountToBuy <= 0n) {
        throw new Error('Amount of keys to buy must be a positive number.');
      }

      const provider = new JsonRpcProvider(rpcUrl);
      wallet = new Wallet(privateKey, provider);
      walletAddress = await wallet.getAddress();

      sharesContract = new Contract(agentId, TRADEABLE_SHARES_ABI, wallet);
      aliTokenContract = new Contract(ALI_TOKEN_ADDRESS, ALI_TOKEN_ERC20_ABI, wallet);

      logger.info(
        `[buyKeysAction] Fetching buy price for ${amount} keys of ALI Agent ${agentId}...`
      );
      const priceForAmountBigInt = await sharesContract.getBuyPriceAfterFee(actualAmountToBuy);
      const priceForAmountFormatted = formatUnits(priceForAmountBigInt, 18); // Assuming 18 decimals for ALI

      logger.info(
        `[buyKeysAction] Price for ${amount} keys is ${priceForAmountFormatted} ALI. Checking allowance...`
      );

      const currentAllowance = await aliTokenContract.allowance(walletAddress, agentId);
      if (currentAllowance < priceForAmountBigInt) {
        logger.info(
          `[buyKeysAction] Insufficient allowance. Current: ${currentAllowance.toString()}, Required: ${priceForAmountBigInt.toString()}. Approving...`
        );
        const approveTx = await aliTokenContract.approve(agentId, MaxUint256); // Approve effectively infinite for simplicity
        logger.info(
          `[buyKeysAction] Approval transaction submitted: ${approveTx.hash}. Waiting for confirmation...`
        );
        const approveReceipt = await approveTx.wait();
        if (!approveReceipt || approveReceipt.status !== 1) {
          throw new Error(
            `ALI Token approval transaction failed or was reverted. Hash: ${approveTx.hash}`
          );
        }
        logger.info(`[buyKeysAction] ALI Token approval confirmed.`);
      } else {
        logger.info(
          `[buyKeysAction] Sufficient allowance already granted: ${formatUnits(currentAllowance, 18)} ALI.`
        );
      }

      logger.info(`[buyKeysAction] Proceeding to buy ${amount} keys for ALI Agent ${agentId}...`);
      // First parameter `payableAmount` is 0 because payment is in ALI tokens (ERC20), not native currency.
      const buyTx = await sharesContract.buyKeys(0n, actualAmountToBuy);
      logger.info(
        `[buyKeysAction] Buy keys transaction submitted: ${buyTx.hash}. Waiting for confirmation...`
      );
      const buyReceipt = await buyTx.wait();

      if (!buyReceipt || buyReceipt.status !== 1) {
        throw new Error(`Buy keys transaction failed or was reverted. Hash: ${buyTx.hash}`);
      }
      logger.info(`[buyKeysAction] Buy keys transaction confirmed.`);

      const newKeyBalance = await sharesContract.balanceOf(walletAddress);
      const newKeyBalanceFormatted = newKeyBalance.toString(); // Keys are typically whole numbers

      const responseText =
        `✅ **Successfully Bought Keys**\n\n` +
        `**Agent ID:** ${agentId}\n` +
        `**Keys Purchased:** ${amount}\n` +
        `**Cost:** ${priceForAmountFormatted} ALI tokens\n` +
        `**Transaction Hash:** ${buyTx.hash}\n` +
        `**Your New Key Balance:** ${newKeyBalanceFormatted} keys\n\n` +
        `🔗 **View Transaction:** https://basescan.org/tx/${buyTx.hash}`;

      const responseContent: Content = {
        text: responseText,
        data: {
          agentId,
          amountBought: amount,
          costInAliTokenSmallestUnit: priceForAmountBigInt.toString(),
          costInAliTokenFormatted: priceForAmountFormatted,
          txHash: buyTx.hash,
          newKeyBalance: newKeyBalanceFormatted,
          blockNumber: buyReceipt.blockNumber,
          gasUsed: buyReceipt.gasUsed.toString(),
          timestamp: new Date().toISOString(),
        },
      };
      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[buyKeysAction] Error:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error during key purchase.';
      const errorContent: Content = {
        text: `❌ **Error buying keys**: ${errorMessage}`,
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
        content: { text: 'Buy 10 keys for ALI agent 0xagentId123...xyz via Alethea.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Okay, attempting to buy 10 keys for agent 0xagentId123...xyz via Alethea. I will first check the price, approve the ALI tokens if necessary, and then execute the purchase.',
          actions: ['ALETHEA_BUY_KEYS'],
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'Purchase 1 key for 0xanotherAgentID via Alethea.' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Understood. Buying 1 key for agent 0xanotherAgentID via Alethea.',
          actions: ['ALETHEA_BUY_KEYS'],
        },
      },
    ],
  ],
};
