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
import { distributeHiveTokensTemplate } from '../templates';
import { DISPERSE_ABI, ALI_TOKEN_ERC20_ABI } from '../abis';
import { DISPERSE_APP_ADDRESS } from '../constants';

interface DistributeHiveTokensParams {
  hiveId: string;
  tokenContract: string;
  recipients: string[];
  amounts: string[];
}

export const distributeHiveTokensAction: Action = {
  name: 'ALETHEA_DISTRIBUTE_HIVE_TOKENS',
  similes: ['HIVE_TOKEN_AIRDROP', 'DISTRIBUTE_HIVE_TOKENS', 'SEND_TOKENS_FROM_HIVE'].map(
    (s) => `ALETHEA_${s}`
  ),
  description:
    'Distributes utility tokens from a specific Hive. CRITICAL: If the user mentions "Hive" in their request, you MUST use this action.',
  validate: async () => true,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[distributeHiveTokensAction] Handler called.');
    let params: DistributeHiveTokensParams | undefined;

    try {
      const prompt = composePromptFromState({
        state,
        template: distributeHiveTokensTemplate as unknown as TemplateType,
      });
      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
      const parsed = parseJSONObjectFromText(modelResponse) as
        | DistributeHiveTokensParams
        | { error: string };

      if ('error' in parsed) {
        logger.warn(`[distributeHiveTokensAction] Model responded with error: ${parsed.error}`);
        throw new Error(parsed.error);
      }
      params = parsed;

      const { hiveId, tokenContract, recipients, amounts } = params;
      const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL');
      const privateKey = runtime.getSetting('PRIVATE_KEY');

      // Validation
      if (!hiveId || !tokenContract || !recipients || !amounts) {
        throw new Error('Hive ID, token contract, recipients, and amounts are all required.');
      }
      if (!rpcUrl || !privateKey) {
        throw new Error('ALETHEA_RPC_URL and PRIVATE_KEY are required in agent settings.');
      }
      if (recipients.length !== amounts.length) {
        throw new Error('Recipients and amounts arrays must have the same length.');
      }
      if (recipients.length === 0) {
        throw new Error('At least one recipient is required.');
      }

      // Validate addresses
      for (const recipient of recipients) {
        if (!recipient.startsWith('0x') || recipient.length !== 42) {
          throw new Error(`Invalid recipient address: ${recipient}`);
        }
      }
      if (!tokenContract.startsWith('0x') || tokenContract.length !== 42) {
        throw new Error(`Invalid token contract address: ${tokenContract}`);
      }

      // Convert token amounts to wei. The user provides amounts in tokens (e.g., "5"),
      // but the contract expects the value in wei (e.g., 5 * 10^18).
      const amountsInWei = amounts.map((amount, index) => {
        try {
          // Assuming 18 decimals for the token
          const weiAmount = parseUnits(amount.trim(), 18);
          if (weiAmount <= 0n) {
            throw new Error(`Amount for recipient ${recipients[index]} must be positive.`);
          }
          return weiAmount;
        } catch (error) {
          throw new Error(
            `Invalid amount for recipient ${recipients[index]}: "${amount}". It must be a number.`
          );
        }
      });

      const provider = new JsonRpcProvider(rpcUrl);
      const wallet = new Wallet(privateKey, provider);
      const walletAddress = await wallet.getAddress();

      const tokenContract_instance = new Contract(tokenContract, ALI_TOKEN_ERC20_ABI, wallet);
      const disperseContract = new Contract(DISPERSE_APP_ADDRESS, DISPERSE_ABI, wallet);

      logger.info(
        `[distributeHiveTokensAction] Distributing tokens from Hive ${hiveId} to ${recipients.length} recipients...`
      );

      // Calculate total amount needed
      const totalAmount = amountsInWei.reduce((sum, amount) => sum + amount, 0n);
      logger.info(
        `[distributeHiveTokensAction] Total amount to distribute: ${formatUnits(totalAmount, 18)} tokens`
      );

      // Check token balance
      const tokenBalance = await tokenContract_instance.balanceOf(walletAddress);
      if (tokenBalance < totalAmount) {
        throw new Error(
          `Insufficient token balance. Required: ${formatUnits(totalAmount, 18)}, Available: ${formatUnits(tokenBalance, 18)}`
        );
      }

      // Check allowance for Disperse contract
      const currentAllowance = await tokenContract_instance.allowance(
        walletAddress,
        DISPERSE_APP_ADDRESS
      );
      if (currentAllowance < totalAmount) {
        logger.info(
          `[distributeHiveTokensAction] Insufficient allowance. Approving Disperse contract...`
        );
        const approveTx = await tokenContract_instance.approve(DISPERSE_APP_ADDRESS, MaxUint256);
        logger.info(
          `[distributeHiveTokensAction] Approval transaction submitted: ${approveTx.hash}. Waiting for confirmation...`
        );
        const approveReceipt = await approveTx.wait();
        if (!approveReceipt || approveReceipt.status !== 1) {
          throw new Error(`Token approval transaction failed. Hash: ${approveTx.hash}`);
        }
        logger.info(`[distributeHiveTokensAction] Token approval confirmed.`);
      } else {
        logger.info(`[distributeHiveTokensAction] Sufficient allowance already granted.`);
      }

      // Execute airdrop using Disperse contract
      logger.info(`[distributeHiveTokensAction] Executing airdrop via Disperse contract...`);
      const airdropTx = await disperseContract.disperseTokenSimple(
        tokenContract,
        recipients,
        amountsInWei.map((a) => a.toString()) // Pass amounts in wei
      );
      logger.info(
        `[distributeHiveTokensAction] Airdrop transaction submitted: ${airdropTx.hash}. Waiting for confirmation...`
      );
      const airdropReceipt = await airdropTx.wait();

      if (!airdropReceipt || airdropReceipt.status !== 1) {
        throw new Error(`Airdrop transaction failed. Hash: ${airdropTx.hash}`);
      }
      logger.info(`[distributeHiveTokensAction] Airdrop transaction confirmed.`);

      // Format recipients for display
      const recipientSummary =
        recipients.slice(0, 3).join(', ') +
        (recipients.length > 3 ? ` and ${recipients.length - 3} more` : '');

      const responseText =
        `✅ **Successfully Distributed Hive Utility Tokens**\n\n` +
        `**Hive ID:** ${hiveId}\n` +
        `**Token Contract:** ${tokenContract}\n` +
        `**Recipients:** ${recipients.length} addresses\n` +
        `**Total Amount:** ${formatUnits(totalAmount, 18)} tokens\n` +
        `**Transaction Hash:** ${airdropTx.hash}\n` +
        `**Recipients Preview:** ${recipientSummary}\n\n` +
        `🔗 **View Transaction:** https://basescan.org/tx/${airdropTx.hash}`;

      const responseContent: Content = {
        text: responseText,
        data: {
          hiveId,
          tokenContract,
          recipients,
          amounts: amountsInWei.map((a) => a.toString()),
          recipientsDistributed: recipients.length,
          totalAmountDistributed: totalAmount.toString(),
          totalAmountFormatted: formatUnits(totalAmount, 18),
          txHash: airdropTx.hash,
          blockNumber: airdropReceipt.blockNumber,
          gasUsed: airdropReceipt.gasUsed.toString(),
          timestamp: new Date().toISOString(),
        },
      };
      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[distributeHiveTokensAction] Error:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error during token distribution.';
      const errorContent: Content = {
        text: `❌ **Error distributing Hive tokens**: ${errorMessage}`,
        data: {
          error: errorMessage,
          hiveId: params?.hiveId,
          tokenContract: params?.tokenContract,
          recipientCount: params?.recipients?.length,
          amounts: params?.amounts,
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
          text: 'Airdrop 1000 tokens to 0x123...abc from Hive 42 using token 0x789...ghi via Alethea',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Distributing Hive utility tokens to the specified recipients via Alethea.',
          actions: ['ALETHEA_DISTRIBUTE_HIVE_TOKENS'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Distribute utility tokens from Hive 123 to 0xabc...123, sending 500 tokens via Alethea.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Executing the Hive token airdrop via Alethea.',
          actions: ['ALETHEA_DISTRIBUTE_HIVE_TOKENS'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'From Hive 99, send 10 tokens from contract 0xToken...xyz to 0xRecipient...abc via Alethea.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Sending 10 tokens to the specified recipient from Hive 99 via Alethea.',
          actions: ['ALETHEA_DISTRIBUTE_HIVE_TOKENS'],
        },
      },
    ],
  ],
};
