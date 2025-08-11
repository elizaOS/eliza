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
import { executeAirdropTemplate } from '../templates';
import { DISPERSE_ABI, ALI_TOKEN_ERC20_ABI } from '../abis';
import { DISPERSE_APP_ADDRESS } from '../constants';

interface ExecuteAirdropParams {
  tokenAddress: string;
  recipients: string[];
  amounts: string[];
}

export const executeAirdropAction: Action = {
  name: 'ALETHEA_EXECUTE_AIRDROP',
  similes: ['GENERIC_TOKEN_AIRDROP', 'SEND_TOKENS_BULK', 'TOKEN_AIRDROP'].map(
    (s) => `ALETHEA_${s}`
  ),
  description:
    'Execute a generic token airdrop. CRITICAL: Do NOT use this for Hive-related airdrops. If the user mentions "Hive", use DISTRIBUTE_HIVE_TOKENS instead.',
  validate: async () => true,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[executeAirdropAction] Handler called.');
    let params: ExecuteAirdropParams | undefined;

    try {
      const prompt = composePromptFromState({
        state,
        template: executeAirdropTemplate as unknown as TemplateType,
      });
      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
      const parsed = parseJSONObjectFromText(modelResponse);

      if (typeof parsed !== 'object' || parsed === null) {
        logger.error(`[executeAirdropAction] Failed to parse model response: ${modelResponse}`);
        throw new Error('Could not parse parameters from model response.');
      }

      const paramsJson = parsed as ExecuteAirdropParams | { error: string };

      if ('error' in paramsJson) {
        logger.warn(`[executeAirdropAction] Model responded with error: ${paramsJson.error}`);
        throw new Error(paramsJson.error);
      }
      params = paramsJson;

      const { tokenAddress, recipients, amounts } = params;
      const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL');
      const privateKey = runtime.getSetting('PRIVATE_KEY');

      // Validation
      if (!tokenAddress || !recipients || !amounts) {
        throw new Error('Token address, recipients, and amounts are all required.');
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
      if (!tokenAddress.startsWith('0x') || tokenAddress.length !== 42) {
        throw new Error(`Invalid token contract address: ${tokenAddress}`);
      }

      // Ensure the token address is not in the recipients list
      const filteredRecipients = recipients.filter(
        (r) => r.toLowerCase() !== tokenAddress.toLowerCase()
      );
      if (filteredRecipients.length !== recipients.length) {
        logger.warn(
          '[executeAirdropAction] Token address was found in recipients list and has been removed.'
        );
      }
      if (filteredRecipients.length === 0) {
        throw new Error('No valid recipients remaining after filtering.');
      }

      // Convert token amounts to wei
      const amountsInWei = amounts.map((amount, index) => {
        try {
          const weiAmount = parseUnits(amount, 18);
          if (weiAmount <= 0n) {
            throw new Error(`Amount for recipient ${recipients[index]} must be positive`);
          }
          return weiAmount;
        } catch (error) {
          throw new Error(
            `Invalid amount for recipient ${recipients[index]}: ${amount} - ${error.message}`
          );
        }
      });

      const provider = new JsonRpcProvider(rpcUrl);
      const wallet = new Wallet(privateKey, provider);
      const walletAddress = await wallet.getAddress();

      const tokenContract = new Contract(tokenAddress, ALI_TOKEN_ERC20_ABI, wallet);
      const disperseContract = new Contract(DISPERSE_APP_ADDRESS, DISPERSE_ABI, wallet);

      logger.info(
        `[executeAirdropAction] Executing airdrop to ${filteredRecipients.length} recipients...`
      );

      // Calculate total amount needed
      const totalAmountInWei = amountsInWei.reduce((sum, amount) => sum + amount, 0n);
      logger.info(
        `[executeAirdropAction] Total amount to airdrop: ${formatUnits(
          totalAmountInWei,
          18
        )} tokens`
      );

      // Check token balance
      const tokenBalance = await tokenContract.balanceOf(walletAddress);
      if (tokenBalance < totalAmountInWei) {
        throw new Error(
          `Insufficient token balance. Required: ${formatUnits(
            totalAmountInWei,
            18
          )}, Available: ${formatUnits(tokenBalance, 18)}`
        );
      }

      // Check allowance for Disperse contract
      const currentAllowance = await tokenContract.allowance(walletAddress, DISPERSE_APP_ADDRESS);
      if (currentAllowance < totalAmountInWei) {
        logger.info(
          `[executeAirdropAction] Insufficient allowance. Approving Disperse contract...`
        );
        const approveTx = await tokenContract.approve(DISPERSE_APP_ADDRESS, MaxUint256);
        logger.info(
          `[executeAirdropAction] Approval transaction submitted: ${approveTx.hash}. Waiting for confirmation...`
        );
        const approveReceipt = await approveTx.wait();
        if (!approveReceipt || approveReceipt.status !== 1) {
          throw new Error(`Token approval transaction failed. Hash: ${approveTx.hash}`);
        }
        logger.info(`[executeAirdropAction] Token approval confirmed.`);
      } else {
        logger.info(`[executeAirdropAction] Sufficient allowance already granted.`);
      }

      // Execute airdrop using Disperse contract
      logger.info(`[executeAirdropAction] Executing airdrop via Disperse contract...`);
      const airdropTx = await disperseContract.disperseTokenSimple(
        tokenAddress,
        filteredRecipients,
        amountsInWei.map((a) => a.toString())
      );
      logger.info(
        `[executeAirdropAction] Airdrop transaction submitted: ${airdropTx.hash}. Waiting for confirmation...`
      );
      const airdropReceipt = await airdropTx.wait();

      if (!airdropReceipt || airdropReceipt.status !== 1) {
        throw new Error(`Airdrop transaction failed. Hash: ${airdropTx.hash}`);
      }
      logger.info(`[executeAirdropAction] Airdrop transaction confirmed.`);

      // Format recipients for display
      const recipientSummary =
        filteredRecipients.slice(0, 3).join(', ') +
        (filteredRecipients.length > 3 ? ` and ${filteredRecipients.length - 3} more` : '');

      const responseText =
        `✅ **Successfully Executed Token Airdrop**\n\n` +
        `**Token Contract:** ${tokenAddress}\n` +
        `**Recipients:** ${filteredRecipients.length} addresses\n` +
        `**Total Amount:** ${formatUnits(totalAmountInWei, 18)} tokens\n` +
        `**Transaction Hash:** ${airdropTx.hash}\n` +
        `**Recipients Preview:** ${recipientSummary}\n\n` +
        `🔗 **View Transaction:** https://basescan.org/tx/${airdropTx.hash}`;

      const responseContent: Content = {
        text: responseText,
        data: {
          tokenAddress,
          recipients: filteredRecipients,
          amounts: amountsInWei.map((a) => a.toString()),
          recipientsDistributed: filteredRecipients.length,
          totalAmountDistributed: totalAmountInWei.toString(),
          totalAmountFormatted: formatUnits(totalAmountInWei, 18),
          txHash: airdropTx.hash,
          blockNumber: airdropReceipt.blockNumber,
          gasUsed: airdropReceipt.gasUsed.toString(),
          timestamp: new Date().toISOString(),
        },
      };
      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[executeAirdropAction] Error:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error during token airdrop.';

      const errorContent: Content = {
        text: `❌ **Failed to Execute Airdrop**: ${errorMessage}`,
        data: {
          error: errorMessage,
          timestamp: new Date().toISOString(),
          params,
        },
      };
      if (callback) await callback(errorContent);
      return errorContent;
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Airdrop 1000 tokens to 0x123...abc and 2000 to 0x456...def using token 0x789...ghi via Alethea',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Executing token airdrop to the specified recipients via Alethea.',
          actions: ['ALETHEA_EXECUTE_AIRDROP'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Bulk send my token 0xToken...xyz: 50 to 0xaaa...bbb, 100 to 0xccc...ddd via Alethea.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Okay, proceeding with the bulk token send via Alethea.',
          actions: ['ALETHEA_EXECUTE_AIRDROP'],
        },
      },
    ],
  ],
};
