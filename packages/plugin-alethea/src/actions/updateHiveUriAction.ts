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
import { updateHiveUriTemplate } from '../templates';
import { HIVE_REGISTRY_ABI } from '../abis';
import { HIVE_REGISTRY_ADDRESS } from '../constants';

// Interface for the parameters accepted by the action
interface UpdateHiveUriParams {
  hiveId: string;
  newUri: string;
}

export const updateHiveUriAction: Action = {
  name: 'ALETHEA_UPDATE_HIVE_URI',
  similes: ['SET_HIVE_URI', 'CHANGE_HIVE_URI', 'MODIFY_HIVE_URI', 'UPDATE_HIVE_METADATA'].map(
    (s) => `ALETHEA_${s}`
  ),
  description: "Update a Hive's metadata URI via the Alethea AI protocol.",

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info(`[updateHiveUriAction] Validate called.`);

    // Check for required environment variables/settings
    const privateKey = runtime.getSetting('PRIVATE_KEY');
    const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL');

    if (!privateKey) {
      logger.error(
        '[updateHiveUriAction] PRIVATE_KEY is required for Hive URI update. Please set it in agent settings.'
      );
      return false;
    }

    if (!rpcUrl) {
      logger.error(
        '[updateHiveUriAction] ALETHEA_RPC_URL is required for Hive URI update. Please set it in agent settings.'
      );
      return false;
    }

    logger.info('[updateHiveUriAction] Basic validation passed.');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[updateHiveUriAction] Handler called.');

    let updateParams: UpdateHiveUriParams | undefined;

    try {
      // Use LLM to extract parameters from natural language
      const prompt = composePromptFromState({
        state,
        template: updateHiveUriTemplate as unknown as TemplateType,
      });

      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      let paramsJson: UpdateHiveUriParams | { error: string };

      try {
        paramsJson = parseJSONObjectFromText(modelResponse) as
          | UpdateHiveUriParams
          | { error: string };
        logger.debug('Update Hive URI parameters extracted:', paramsJson);

        // Check if the model response contains an error
        if ('error' in paramsJson) {
          logger.warn(`Update Hive URI action: Model responded with error: ${paramsJson.error}`);
          throw new Error(paramsJson.error);
        }

        // At this point, paramsJson must be UpdateHiveUriParams
        updateParams = paramsJson;
      } catch (e) {
        logger.error('Failed to parse LLM response for update hive URI params:', modelResponse, e);
        throw new Error('Could not understand Hive URI update parameters.');
      }

      // Parameter extraction
      const hiveId = updateParams.hiveId;
      const newUri = updateParams.newUri;

      const privateKey = runtime.getSetting('PRIVATE_KEY');
      const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL');

      // Validation - only check extracted parameters now, env vars already validated
      if (!hiveId) {
        const errMsg = 'Hive ID is required to update Hive URI.';
        logger.error(`[updateHiveUriAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ Error: ${errMsg}` });
        throw new Error(errMsg);
      }

      if (!newUri) {
        const errMsg = 'New URI is required to update Hive URI.';
        logger.error(`[updateHiveUriAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ Error: ${errMsg}` });
        throw new Error(errMsg);
      }

      // Initialize provider and wallet
      const provider = new JsonRpcProvider(rpcUrl);
      const wallet = new Wallet(privateKey, provider);
      const walletAddress = await wallet.getAddress();

      // Initialize contract
      const hiveRegistryContract = new Contract(HIVE_REGISTRY_ADDRESS, HIVE_REGISTRY_ABI, wallet);

      logger.info(`[updateHiveUriAction] Verifying Hive ownership...`);

      // Get Hive details to verify ownership
      const hiveDetails = await hiveRegistryContract.getHiveDetails(BigInt(hiveId));
      const hiveOwner = hiveDetails.hiveOwner;

      if (hiveOwner.toLowerCase() !== walletAddress.toLowerCase()) {
        const errMsg = `You must own the Hive to update its URI. Current owner: ${hiveOwner}, Your address: ${walletAddress}`;
        logger.error(`[updateHiveUriAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ Error: ${errMsg}` });
        throw new Error(errMsg);
      }

      logger.info(`[updateHiveUriAction] Updating Hive ${hiveId} URI to ${newUri}...`);

      // Update Hive URI by calling updateHiveURI function
      const tx = await hiveRegistryContract.updateHiveURI(BigInt(hiveId), newUri);

      logger.info(`[updateHiveUriAction] Transaction submitted: ${tx.hash}`);

      // Wait for transaction confirmation
      const receipt = await tx.wait();

      if (!receipt || receipt.status !== 1) {
        throw new Error('Transaction failed or was reverted');
      }

      logger.info(`[updateHiveUriAction] Transaction confirmed. Hive URI updated successfully.`);

      let responseText = `✅ **Hive URI Successfully Updated**\n\n`;
      responseText += `**Hive ID:** ${hiveId}\n`;
      responseText += `**New URI:** ${newUri}\n`;
      responseText += `**Transaction Hash:** ${tx.hash}\n`;
      responseText += `**Block Number:** ${receipt.blockNumber}\n`;
      responseText += `**Gas Used:** ${receipt.gasUsed.toString()}\n\n`;
      responseText += `🔗 **View Transaction:** https://basescan.org/tx/${tx.hash}`;

      const responseContent: Content = {
        text: responseText,
        data: {
          hiveId,
          newUri,
          txHash: tx.hash,
          hiveRegistryAddress: HIVE_REGISTRY_ADDRESS,
          hiveOwner,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[updateHiveUriAction] Error:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error during Hive URI update.';
      const errorContent: Content = {
        text: `❌ **Error updating Hive URI**: ${errorMessage}`,
        data: {
          error: errorMessage,
          hiveId: updateParams?.hiveId,
          newUri: updateParams?.newUri,
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
          text: 'Update Hive 123 URI to https://example.com/new-metadata.json via Alethea.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'I will update Hive 123 with the new metadata URI via Alethea. Let me verify ownership and execute the update.',
          actions: ['ALETHEA_UPDATE_HIVE_URI'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Change the metadata for Hive ID 456 to ipfs://QmNewHash123... via Alethea',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Updating Hive 456 metadata to the new IPFS URI via Alethea.',
          actions: ['ALETHEA_UPDATE_HIVE_URI'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Set the URI for my Hive 789 to an empty string for now via Alethea.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Setting Hive 789 URI to empty string as requested via Alethea.',
          actions: ['ALETHEA_UPDATE_HIVE_URI'],
        },
      },
    ],
  ],
};
