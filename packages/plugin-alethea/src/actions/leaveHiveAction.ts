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
import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import { leaveHiveTemplate } from '../templates';
import { HIVE_REGISTRY_ABI, ERC721_ABI } from '../abis';
import { HIVE_REGISTRY_ADDRESS } from '../constants';

// Interface for the parameters accepted by the action
interface LeaveHiveParams {
  assetContract: string;
  assetId: string;
}

export const leaveHiveAction: Action = {
  name: 'ALETHEA_LEAVE_HIVE',
  similes: [
    'UNLINK_ASSET',
    'REMOVE_ASSET_FROM_HIVE',
    'DISCONNECT_FROM_HIVE',
    'UNLINK_FROM_HIVE',
  ].map((s) => `ALETHEA_${s}`),
  description: 'Leave a Hive by unlinking an asset (NFT) from it via the Alethea AI protocol.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info(`[leaveHiveAction] Validate called.`);

    // Check for required environment variables/settings
    const privateKey = runtime.getSetting('PRIVATE_KEY');
    const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL');

    if (!privateKey) {
      logger.error(
        '[leaveHiveAction] PRIVATE_KEY is required for leaving Hive. Please set it in agent settings.'
      );
      return false;
    }

    if (!rpcUrl) {
      logger.error(
        '[leaveHiveAction] ALETHEA_RPC_URL is required for leaving Hive. Please set it in agent settings.'
      );
      return false;
    }

    logger.info('[leaveHiveAction] Basic validation passed.');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[leaveHiveAction] Handler called.');

    let leaveParams: LeaveHiveParams | undefined;

    try {
      // Use LLM to extract parameters from natural language
      const prompt = composePromptFromState({
        state,
        template: leaveHiveTemplate as unknown as TemplateType,
      });

      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      let paramsJson: LeaveHiveParams | { error: string };

      try {
        paramsJson = parseJSONObjectFromText(modelResponse) as LeaveHiveParams | { error: string };
        logger.debug('Leave Hive parameters extracted:', paramsJson);

        // Check if the model response contains an error
        if ('error' in paramsJson) {
          logger.warn(`Leave Hive action: Model responded with error: ${paramsJson.error}`);
          throw new Error(paramsJson.error);
        }

        // At this point, paramsJson must be LeaveHiveParams
        leaveParams = paramsJson;
      } catch (e) {
        logger.error('Failed to parse LLM response for leave hive params:', modelResponse, e);
        throw new Error('Could not understand leave Hive parameters.');
      }

      // Parameter extraction
      const assetContract = leaveParams.assetContract;
      const assetId = leaveParams.assetId;

      const privateKey = runtime.getSetting('PRIVATE_KEY');
      const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL');

      // Validation - only check extracted parameters now, env vars already validated
      if (!assetContract) {
        const errMsg = 'Asset contract address is required to leave a Hive.';
        logger.error(`[leaveHiveAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ Error: ${errMsg}` });
        throw new Error(errMsg);
      }

      if (!assetId) {
        const errMsg = 'Asset token ID is required to leave a Hive.';
        logger.error(`[leaveHiveAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ Error: ${errMsg}` });
        throw new Error(errMsg);
      }

      // Initialize provider and wallet
      const provider = new JsonRpcProvider(rpcUrl);
      const wallet = new Wallet(privateKey, provider);
      const walletAddress = await wallet.getAddress();

      // Initialize contracts
      const assetContractInstance = new Contract(assetContract, ERC721_ABI, provider);
      const hiveRegistryContract = new Contract(HIVE_REGISTRY_ADDRESS, HIVE_REGISTRY_ABI, wallet);

      logger.info(`[leaveHiveAction] Verifying asset ownership...`);

      // Verify asset ownership
      const assetOwner = await assetContractInstance.ownerOf(BigInt(assetId));

      if (assetOwner.toLowerCase() !== walletAddress.toLowerCase()) {
        const errMsg = `You must own the asset to unlink it from a Hive. Current owner: ${assetOwner}, Your address: ${walletAddress}`;
        logger.error(`[leaveHiveAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ Error: ${errMsg}` });
        throw new Error(errMsg);
      }

      logger.info(`[leaveHiveAction] Checking asset linking status...`);

      // Check if asset is currently linked to a Hive
      const asset = {
        tokenAddress: assetContract,
        tokenId: BigInt(assetId),
      };

      let linkedHiveId: number;
      try {
        const linkedDetails = await hiveRegistryContract.getLinkedAssetDetails(asset);
        linkedHiveId = linkedDetails.hiveId;

        if (!linkedHiveId || linkedHiveId === 0) {
          const errMsg = `Asset is not currently linked to any Hive.`;
          logger.error(`[leaveHiveAction] ${errMsg}`);
          if (callback) await callback({ text: `❌ Error: ${errMsg}` });
          throw new Error(errMsg);
        }

        logger.info(`[leaveHiveAction] Asset is currently linked to Hive ${linkedHiveId}`);
      } catch (error) {
        const errMsg = `Failed to check asset linking status or asset is not linked to any Hive.`;
        logger.error(`[leaveHiveAction] ${errMsg}`, error);
        if (callback) await callback({ text: `❌ Error: ${errMsg}` });
        throw new Error(errMsg);
      }

      logger.info(`[leaveHiveAction] Unlinking asset from Hive ${linkedHiveId}...`);

      // Unlink asset from Hive by calling unlinkAsset function
      const tx = await hiveRegistryContract.unlinkAsset(asset);

      logger.info(`[leaveHiveAction] Transaction submitted: ${tx.hash}`);

      // Wait for transaction confirmation
      const receipt = await tx.wait();

      if (!receipt || receipt.status !== 1) {
        throw new Error('Transaction failed or was reverted');
      }

      logger.info(
        `[leaveHiveAction] Transaction confirmed. Asset successfully unlinked from Hive.`
      );

      let responseText = `✅ **Asset Successfully Unlinked from Hive**\n\n`;
      responseText += `**Previous Hive ID:** ${linkedHiveId}\n`;
      responseText += `**Asset Contract:** ${assetContract}\n`;
      responseText += `**Asset ID:** ${assetId}\n`;
      responseText += `**Transaction Hash:** ${tx.hash}\n`;
      responseText += `**Block Number:** ${receipt.blockNumber}\n`;
      responseText += `**Gas Used:** ${receipt.gasUsed.toString()}\n\n`;
      responseText += `🔗 **View Transaction:** https://basescan.org/tx/${tx.hash}`;

      const responseContent: Content = {
        text: responseText,
        data: {
          previousHiveId: linkedHiveId,
          assetContract,
          assetId,
          txHash: tx.hash,
          hiveRegistryAddress: HIVE_REGISTRY_ADDRESS,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[leaveHiveAction] Error:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error during Hive leaving.';
      const errorContent: Content = {
        text: `❌ **Error leaving Hive**: ${errorMessage}`,
        data: {
          error: errorMessage,
          assetContract: leaveParams?.assetContract,
          assetId: leaveParams?.assetId,
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
          text: 'Unlink my NFT at contract 0x1234...5678 token ID 123 from its Hive via Alethea.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'I will unlink your NFT (contract 0x1234...5678, token 123) from its current Hive via Alethea. Let me verify ownership and execute the unlinking.',
          actions: ['ALETHEA_LEAVE_HIVE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: "Remove my AI Pod 42 from whatever Hive it's in via Alethea." },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Removing your AI Pod 42 from its current Hive via Alethea.',
          actions: ['ALETHEA_LEAVE_HIVE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Disconnect my asset 999 from its Hive via Alethea.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Disconnecting asset 999 from its Hive via Alethea.',
          actions: ['ALETHEA_LEAVE_HIVE'],
        },
      },
    ],
  ],
};
