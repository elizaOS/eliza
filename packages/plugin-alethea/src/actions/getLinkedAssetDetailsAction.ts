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
import { Contract, JsonRpcProvider } from 'ethers';
import { getLinkedAssetDetailsTemplate } from '../templates';
import { HIVE_REGISTRY_ABI, ERC721_ABI } from '../abis';
import { HIVE_REGISTRY_ADDRESS } from '../constants';

// Interface for the parameters accepted by the action
interface GetLinkedAssetDetailsParams {
  hiveId: string;
  assetContract?: string; // Optional - if provided, check specific asset
  assetId?: string; // Optional - if provided, check specific asset
}

export const getLinkedAssetDetailsAction: Action = {
  name: 'ALETHEA_GET_LINKED_ASSET_DETAILS',
  similes: [
    'CHECK_HIVE_MEMBERSHIP',
    'GET_HIVE_ASSET_INFO',
    'CHECK_ASSET_MEMBERSHIP',
    'GET_HIVE_INFO',
  ].map((s) => `ALETHEA_${s}`),
  description: 'Get linked asset details and check Hive membership via the Alethea AI protocol.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info(`[getLinkedAssetDetailsAction] Validate called.`);

    // Check for required environment variables/settings
    const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL');

    if (!rpcUrl) {
      logger.error(
        '[getLinkedAssetDetailsAction] ALETHEA_RPC_URL is required for getting asset details. Please set it in agent settings.'
      );
      return false;
    }

    logger.info('[getLinkedAssetDetailsAction] Basic validation passed.');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getLinkedAssetDetailsAction] Handler called.');

    let queryParams: GetLinkedAssetDetailsParams | undefined;

    try {
      // Use LLM to extract parameters from natural language
      const prompt = composePromptFromState({
        state,
        template: getLinkedAssetDetailsTemplate as unknown as TemplateType,
      });

      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      let paramsJson: GetLinkedAssetDetailsParams | { error: string };

      try {
        paramsJson = parseJSONObjectFromText(modelResponse) as
          | GetLinkedAssetDetailsParams
          | { error: string };
        logger.debug('Get linked asset details parameters extracted:', paramsJson);

        // Check if the model response contains an error
        if ('error' in paramsJson) {
          logger.warn(
            `Get linked asset details action: Model responded with error: ${paramsJson.error}`
          );
          throw new Error(paramsJson.error);
        }

        // At this point, paramsJson must be GetLinkedAssetDetailsParams
        queryParams = paramsJson;
      } catch (e) {
        logger.error(
          'Failed to parse LLM response for get linked asset details params:',
          modelResponse,
          e
        );
        throw new Error('Could not understand asset details query parameters.');
      }

      // Parameter extraction
      const hiveId = queryParams.hiveId;
      const assetContract = queryParams.assetContract;
      const assetId = queryParams.assetId;

      const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL');

      // Validation - check extracted parameters
      if (!hiveId) {
        const errMsg = 'Hive ID is required to get asset details.';
        logger.error(`[getLinkedAssetDetailsAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ Error: ${errMsg}` });
        throw new Error(errMsg);
      }

      // Initialize provider
      const provider = new JsonRpcProvider(rpcUrl);
      const hiveRegistryContract = new Contract(HIVE_REGISTRY_ADDRESS, HIVE_REGISTRY_ABI, provider);

      logger.info(`[getLinkedAssetDetailsAction] Getting details for Hive ${hiveId}...`);

      // Get basic Hive details first
      let hiveDetails;
      try {
        hiveDetails = await hiveRegistryContract.getHiveDetails(BigInt(hiveId));
      } catch (error) {
        const errMsg = `Failed to get Hive details for Hive ID ${hiveId}. The Hive may not exist.`;
        logger.error(`[getLinkedAssetDetailsAction] ${errMsg}`, error);
        if (callback) await callback({ text: `❌ Error: ${errMsg}` });
        throw new Error(errMsg);
      }

      // Get number of assets linked to the Hive
      const numLinkedAssets = await hiveRegistryContract.getNumOfAssetsLinkedWithHive(
        BigInt(hiveId)
      );

      let responseData: any = {
        hiveId,
        hiveDetails: {
          pod: {
            tokenAddress: hiveDetails.pod.tokenAddress,
            tokenId: hiveDetails.pod.tokenId.toString(),
          },
          hiveOwner: hiveDetails.hiveOwner,
          hiveTokenAddr: hiveDetails.hiveTokenAddr,
          hiveUri: hiveDetails.hiveUri,
        },
        numLinkedAssets: numLinkedAssets.toString(),
        timestamp: new Date().toISOString(),
      };

      let responseText = `✅ **Hive Information Retrieved**\n\n`;
      responseText += `**Hive ID:** ${hiveId}\n`;
      responseText += `**Hive Owner:** ${hiveDetails.hiveOwner}\n`;
      responseText += `**Creator Pod Contract:** ${hiveDetails.pod.tokenAddress}\n`;
      responseText += `**Creator Pod Token ID:** ${hiveDetails.pod.tokenId.toString()}\n`;
      responseText += `**Hive Token Address:** ${hiveDetails.hiveTokenAddr}\n`;
      responseText += `**Hive URI:** ${hiveDetails.hiveUri}\n`;
      responseText += `**Number of Linked Assets:** ${numLinkedAssets.toString()}\n`;

      // If specific asset is requested, check its membership
      if (assetContract && assetId) {
        logger.info(
          `[getLinkedAssetDetailsAction] Checking specific asset membership: ${assetContract}:${assetId}`
        );

        try {
          const asset = {
            tokenAddress: assetContract,
            tokenId: BigInt(assetId),
          };

          const linkedDetails = await hiveRegistryContract.getLinkedAssetDetails(asset);
          const linkedHiveId = linkedDetails.hiveId;

          // Check if the asset is linked to the requested Hive
          const isLinkedToThisHive = linkedHiveId.toString() === hiveId;

          responseData.specificAssetQuery = {
            assetContract,
            assetId,
            isLinkedToRequestedHive: isLinkedToThisHive,
            actualLinkedHiveId: linkedHiveId.toString(),
            categoryId: linkedDetails.categoryId.toString(),
            category: linkedDetails.category,
          };

          responseText += `\n**🔍 Specific Asset Query Results:**\n`;
          responseText += `**Asset Contract:** ${assetContract}\n`;
          responseText += `**Asset ID:** ${assetId}\n`;
          responseText += `**Linked to Requested Hive:** ${isLinkedToThisHive ? '✅ Yes' : '❌ No'}\n`;

          if (linkedHiveId && linkedHiveId > 0) {
            responseText += `**Actually Linked to Hive:** ${linkedDetails.hiveId.toString()}\n`;
            responseText += `**Category ID:** ${linkedDetails.categoryId.toString()}\n`;
            responseText += `**Category:** ${linkedDetails.category}\n`;
          } else {
            responseText += `**Status:** Asset is not linked to any Hive\n`;
          }
        } catch (error) {
          logger.warn(
            `[getLinkedAssetDetailsAction] Asset ${assetContract}:${assetId} may not be linked to any Hive`,
            error
          );

          responseData.specificAssetQuery = {
            assetContract,
            assetId,
            isLinkedToRequestedHive: false,
            actualLinkedHiveId: '0',
            categoryId: '0',
            category: 'Not linked',
            error: 'Asset is not linked to any Hive',
          };

          responseText += `\n**🔍 Specific Asset Query Results:**\n`;
          responseText += `**Asset Contract:** ${assetContract}\n`;
          responseText += `**Asset ID:** ${assetId}\n`;
          responseText += `**Status:** ❌ Asset is not linked to any Hive\n`;
        }
      } else {
        responseText += `\n💡 **Note:** To check if a specific asset is linked to this Hive, provide the asset contract address and token ID in your query.`;
      }

      const responseContent: Content = {
        text: responseText,
        data: responseData,
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[getLinkedAssetDetailsAction] Error:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error during asset details retrieval.';
      const errorContent: Content = {
        text: `❌ **Error getting asset details**: ${errorMessage}`,
        data: {
          error: errorMessage,
          hiveId: queryParams?.hiveId,
          assetContract: queryParams?.assetContract,
          assetId: queryParams?.assetId,
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
          text: 'Get details for Hive 123 via Alethea. Also, check if asset 0xAssetContract... token 777 is a member.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'I will get the details for Hive 123 and check the membership status of the specified asset via Alethea.',
          actions: ['ALETHEA_GET_LINKED_ASSET_DETAILS'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Show me info about Hive 456 via Alethea.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Retrieving information for Hive 456 via Alethea.',
          actions: ['ALETHEA_GET_LINKED_ASSET_DETAILS'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Is my NFT 0xNftAddress... token 1 linked to Hive 10 via Alethea?',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "Let's check the linkage of your NFT with Hive 10 via Alethea.",
          actions: ['ALETHEA_GET_LINKED_ASSET_DETAILS'],
        },
      },
    ],
  ],
};
