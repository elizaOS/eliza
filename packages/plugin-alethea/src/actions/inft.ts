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
import { ethers, Wallet, JsonRpcProvider, Contract, Interface } from 'ethers';
import { upgradeInftIntelligenceTemplate } from '../templates/inft';
import {
  ALI_TOKEN_ADDRESS_ETHEREUM,
  INTELLIGENT_NFT_V2_ADDRESS,
  calculateLevelFromAliLocked,
} from '../constants';
import { ALI_TOKEN_ERC20_ABI, INTELLIGENT_NFT_V2_ABI } from '../abis';

interface UpgradeInftParams {
  inftId: string;
  aliAmount: string;
}

export const upgradeInftIntelligenceAction: Action = {
  name: 'ALETHEA_UPGRADE_INFT_INTELLIGENCE',
  similes: ['UPGRADE_INFT', 'LEVEL_UP_INFT', 'BOOST_INFT_INTELLIGENCE'].map((s) => `ALETHEA_${s}`),
  description: "Upgrade an iNFT's Intelligence Level by locking ALI tokens.",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    logger.info('[upgradeInftIntelligenceAction] Validate called.');
    const privateKey = runtime.getSetting('PRIVATE_KEY');
    if (!privateKey) {
      logger.error(
        '[upgradeInftIntelligenceAction] PRIVATE_KEY is required. Please set it in agent settings.'
      );
      return false;
    }
    const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL');
    if (!rpcUrl) {
      logger.error(
        '[upgradeInftIntelligenceAction] ALETHEA_RPC_URL is required. Please set it in agent settings.'
      );
      return false;
    }
    logger.info('[upgradeInftIntelligenceAction] Basic validation passed.');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[upgradeInftIntelligenceAction] Handler called.');

    let params: UpgradeInftParams | undefined;

    try {
      const prompt = composePromptFromState({
        state,
        template: upgradeInftIntelligenceTemplate as unknown as TemplateType,
      });
      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
      const parsedParams = parseJSONObjectFromText(modelResponse) as
        | UpgradeInftParams
        | { error: string };

      if ('error' in parsedParams) {
        throw new Error(`Model responded with error: ${parsedParams.error}`);
      }
      params = parsedParams;
      const { inftId, aliAmount } = params;

      if (!inftId || !aliAmount) {
        throw new Error('iNFT ID and ALI Amount are required.');
      }

      const privateKey = runtime.getSetting('PRIVATE_KEY') as string;
      const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL') as string;
      const provider = new JsonRpcProvider(rpcUrl);
      const wallet = new Wallet(privateKey, provider);

      const aliTokenContract = new Contract(
        ALI_TOKEN_ADDRESS_ETHEREUM,
        ALI_TOKEN_ERC20_ABI,
        wallet
      );
      const intelligentNftContract = new Contract(
        INTELLIGENT_NFT_V2_ADDRESS,
        INTELLIGENT_NFT_V2_ABI,
        wallet
      );

      const owner = await intelligentNftContract.ownerOf(inftId);
      if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
        throw new Error(`You are not the owner of iNFT ${inftId}.`);
      }

      const aliAmountWei = ethers.parseEther(aliAmount);
      const currentBalance = await aliTokenContract.balanceOf(wallet.address);

      if (currentBalance < aliAmountWei) {
        throw new Error(
          `Insufficient ALI balance. Required: ${aliAmount}, Available: ${ethers.formatEther(currentBalance)}`
        );
      }

      const currentAllowance = await aliTokenContract.allowance(
        wallet.address,
        INTELLIGENT_NFT_V2_ADDRESS
      );
      if (currentAllowance < aliAmountWei) {
        logger.info(
          `[upgradeInftIntelligenceAction] Allowance is insufficient. Approving ${aliAmount} ALI...`
        );
        const approveTx = await aliTokenContract.approve(INTELLIGENT_NFT_V2_ADDRESS, aliAmountWei);
        await approveTx.wait();
        logger.info(
          `[upgradeInftIntelligenceAction] Approval transaction confirmed: ${approveTx.hash}`
        );
      }

      logger.info(
        `[upgradeInftIntelligenceAction] Upgrading iNFT ${inftId} with ${aliAmount} ALI...`
      );
      const upgradeTx = await intelligentNftContract.increaseAli(inftId, aliAmountWei);
      const txReceipt = await upgradeTx.wait();
      logger.info(
        `[upgradeInftIntelligenceAction] Upgrade transaction confirmed: ${txReceipt.hash}`
      );

      const iNftInterface = new Interface(INTELLIGENT_NFT_V2_ABI);
      const updatedEvent = txReceipt.logs
        .map((log: any) => iNftInterface.parseLog(log))
        .find((log: any) => log.name === 'Updated');

      if (!updatedEvent) {
        throw new Error('Could not find the Updated event in the transaction receipt.');
      }

      const newTotalAliLocked = updatedEvent.args._newAliValue;
      const newLevel = calculateLevelFromAliLocked(newTotalAliLocked);

      const responseText =
        `✅ **iNFT Upgraded Successfully!**\n\n` +
        `**iNFT ID:** ${inftId}\n` +
        `**New Intelligence Level:** ${newLevel}\n` +
        `**Total ALI Locked:** ${ethers.formatEther(newTotalAliLocked)} ALI\n` +
        `**Transaction Hash:** ${txReceipt.hash}`;

      const responseContent: Content = {
        text: responseText,
        data: { newLevel, totalAliLocked: newTotalAliLocked.toString(), txHash: txReceipt.hash },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[upgradeInftIntelligenceAction] Error:', error);
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error upgrading iNFT**: ${errorMessage}`,
        data: { error: errorMessage, ...params },
      };
      if (callback) await callback(errorContent);
      throw error;
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Upgrade my iNFT 123 with 3000 ALI tokens via Alethea.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Initiating intelligence upgrade for iNFT 123 via Alethea...',
          actions: ['ALETHEA_UPGRADE_INFT_INTELLIGENCE'],
        },
      },
    ],
  ],
};
