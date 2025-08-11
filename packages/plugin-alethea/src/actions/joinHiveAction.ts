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
import { joinHiveTemplate } from '../templates';
import { HIVE_REGISTRY_ABI, ERC721_ABI } from '../abis';
import { HIVE_REGISTRY_ADDRESS } from '../constants';

// Interface for the parameters accepted by the action
interface JoinHiveParams {
  hiveId: string;
  assetContract: string;
  assetId: string;
  category?: string; // Optional, defaults to 1 for Intelligence_POD
}

export const joinHiveAction: Action = {
  name: 'ALETHEA_JOIN_HIVE',
  similes: ['LINK_ASSET', 'ADD_ASSET_TO_HIVE', 'CONNECT_TO_HIVE', 'LINK_TO_HIVE'].map(
    (s) => `ALETHEA_${s}`
  ),
  description: 'Join a Hive by linking an asset (NFT) to it via the Alethea AI protocol.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info(`[joinHiveAction] Validate called.`);

    // Check for required environment variables/settings
    const privateKey = runtime.getSetting('PRIVATE_KEY');
    const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL');

    if (!privateKey) {
      logger.error(
        '[joinHiveAction] PRIVATE_KEY is required for joining Hive. Please set it in agent settings.'
      );
      return false;
    }

    if (!rpcUrl) {
      logger.error(
        '[joinHiveAction] ALETHEA_RPC_URL is required for joining Hive. Please set it in agent settings.'
      );
      return false;
    }

    logger.info('[joinHiveAction] Basic validation passed.');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[joinHiveAction] Handler called.');

    let joinParams: JoinHiveParams | undefined;

    try {
      // Use LLM to extract parameters from natural language
      const prompt = composePromptFromState({
        state,
        template: joinHiveTemplate as unknown as TemplateType,
      });

      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      let paramsJson: JoinHiveParams | { error: string };

      try {
        paramsJson = parseJSONObjectFromText(modelResponse) as JoinHiveParams | { error: string };
        logger.debug('Join Hive parameters extracted:', paramsJson);

        // Check if the model response contains an error
        if ('error' in paramsJson) {
          logger.warn(`Join Hive action: Model responded with error: ${paramsJson.error}`);
          throw new Error(paramsJson.error);
        }

        // At this point, paramsJson must be JoinHiveParams
        joinParams = paramsJson;
      } catch (e) {
        logger.error('Failed to parse LLM response for join hive params:', modelResponse, e);
        throw new Error('Could not understand join Hive parameters.');
      }

      // Parameter extraction
      const hiveId = joinParams.hiveId;
      const assetContract = joinParams.assetContract;
      const assetId = joinParams.assetId;
      const category = joinParams.category || '1'; // Default to Intelligence_POD

      const privateKey = runtime.getSetting('PRIVATE_KEY');
      const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL');

      // Validation - only check extracted parameters now, env vars already validated
      if (!hiveId) {
        const errMsg = 'Hive ID is required to join a Hive.';
        logger.error(`[joinHiveAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ Error: ${errMsg}` });
        throw new Error(errMsg);
      }

      if (!assetContract) {
        const errMsg = 'Asset contract address is required to join a Hive.';
        logger.error(`[joinHiveAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ Error: ${errMsg}` });
        throw new Error(errMsg);
      }

      if (!assetId) {
        const errMsg = 'Asset token ID is required to join a Hive.';
        logger.error(`[joinHiveAction] ${errMsg}`);
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

      logger.info(`[joinHiveAction] Verifying asset ownership...`);

      // Verify asset ownership
      const assetOwner = await assetContractInstance.ownerOf(BigInt(assetId));

      if (assetOwner.toLowerCase() !== walletAddress.toLowerCase()) {
        const errMsg = `You must own the asset to link it to a Hive. Current owner: ${assetOwner}, Your address: ${walletAddress}`;
        logger.error(`[joinHiveAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ Error: ${errMsg}` });
        throw new Error(errMsg);
      }

      logger.info(`[joinHiveAction] Checking if asset is already linked...`);

      // Check if asset is already linked to a Hive
      const asset = {
        tokenAddress: assetContract,
        tokenId: BigInt(assetId),
      };

      try {
        const linkedDetails = await hiveRegistryContract.getLinkedAssetDetails(asset);
        if (linkedDetails.hiveId && linkedDetails.hiveId > 0) {
          const errMsg = `Asset is already linked to Hive ${linkedDetails.hiveId}. Please unlink it first before joining a different Hive.`;
          logger.error(`[joinHiveAction] ${errMsg}`);
          if (callback) await callback({ text: `❌ Error: ${errMsg}` });
          throw new Error(errMsg);
        }
      } catch (error) {
        // If the call fails, it likely means the asset is not linked, which is what we want
        logger.info(`[joinHiveAction] Asset appears to be unlinked (expected for new linking).`);
      }

      logger.info(`[joinHiveAction] Linking asset to Hive ${hiveId}...`);

      // Link asset to Hive by calling linkAsset function
      const tx = await hiveRegistryContract.linkAsset(asset, BigInt(hiveId), BigInt(category));

      logger.info(`[joinHiveAction] Transaction submitted: ${tx.hash}`);

      // Wait for transaction confirmation
      const receipt = await tx.wait();

      if (!receipt || receipt.status !== 1) {
        throw new Error('Transaction failed or was reverted');
      }

      logger.info(`[joinHiveAction] Transaction confirmed. Asset successfully linked to Hive.`);

      let responseText = `✅ **Asset Successfully Linked to Hive**\n\n`;
      responseText += `**Hive ID:** ${hiveId}\n`;
      responseText += `**Asset Contract:** ${assetContract}\n`;
      responseText += `**Asset ID:** ${assetId}\n`;
      responseText += `**Category:** ${category}\n`;
      responseText += `**Transaction Hash:** ${tx.hash}\n`;
      responseText += `**Block Number:** ${receipt.blockNumber}\n`;
      responseText += `**Gas Used:** ${receipt.gasUsed.toString()}\n\n`;
      responseText += `🔗 **View Transaction:** https://basescan.org/tx/${tx.hash}`;

      const responseContent: Content = {
        text: responseText,
        data: {
          hiveId,
          assetContract,
          assetId,
          category,
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
      logger.error('[joinHiveAction] Error:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error during Hive joining.';
      const errorContent: Content = {
        text: `❌ **Error joining Hive**: ${errorMessage}`,
        data: {
          error: errorMessage,
          hiveId: joinParams?.hiveId,
          assetContract: joinParams?.assetContract,
          assetId: joinParams?.assetId,
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
          text: 'Link my NFT at contract 0x1234...5678 token ID 123 to Hive 456 via Alethea.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'I will link your NFT (contract 0x1234...5678, token 123) to Hive 456 via Alethea. Let me verify ownership and execute the linking.',
          actions: ['ALETHEA_JOIN_HIVE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Join Hive 789 with my AI Pod 42 from the standard contract via Alethea.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Joining Hive 789 with your AI Pod via Alethea.',
          actions: ['ALETHEA_JOIN_HIVE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'I need to link asset 999 from contract 0x... to Hive 111 with category 2 (e.g., "Artistic") via Alethea.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Adding asset 999 to Hive 111 with category 2 via Alethea.',
          actions: ['ALETHEA_JOIN_HIVE'],
        },
      },
    ],
  ],
};
