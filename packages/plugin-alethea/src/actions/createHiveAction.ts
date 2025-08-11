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
import { createHiveTemplate } from '../templates';
import { HIVE_REGISTRY_ABI, ERC721_ABI } from '../abis';
import { HIVE_REGISTRY_ADDRESS, AI_POD_CONTRACT_ADDRESS } from '../constants';

// Interface for the parameters accepted by the action
interface CreateHiveParams {
  podId: string;
  hiveURI: string;
  name?: string; // Optional, for user convenience only
}

export const createHiveAction: Action = {
  name: 'ALETHEA_CREATE_HIVE',
  similes: ['LAUNCH_HIVE', 'START_HIVE', 'ESTABLISH_HIVE', 'MAKE_HIVE', 'NEW_HIVE'].map(
    (s) => `ALETHEA_${s}`
  ),
  description: 'Create a new Hive using a Level 5 AI Pod via the Alethea AI protocol.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info(`[createHiveAction] Validate called.`);

    // Check for required environment variables/settings
    const privateKey = runtime.getSetting('PRIVATE_KEY');
    const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL');

    if (!privateKey) {
      logger.error(
        '[createHiveAction] PRIVATE_KEY is required for Hive creation. Please set it in agent settings.'
      );
      return false;
    }

    if (!rpcUrl) {
      logger.error(
        '[createHiveAction] ALETHEA_RPC_URL is required for Hive creation. Please set it in agent settings.'
      );
      return false;
    }

    logger.info('[createHiveAction] Basic validation passed.');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[createHiveAction] Handler called.');

    let createHiveParams: CreateHiveParams | undefined;

    try {
      // Use LLM to extract parameters from natural language
      const prompt = composePromptFromState({
        state,
        template: createHiveTemplate as unknown as TemplateType,
      });

      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      let paramsJson: CreateHiveParams | { error: string };

      try {
        paramsJson = parseJSONObjectFromText(modelResponse) as CreateHiveParams | { error: string };
        logger.debug('Create Hive parameters extracted:', paramsJson);

        // Check if the model response contains an error
        if ('error' in paramsJson) {
          logger.warn(`Create Hive action: Model responded with error: ${paramsJson.error}`);
          throw new Error(paramsJson.error);
        }

        // At this point, paramsJson must be CreateHiveParams
        createHiveParams = paramsJson;
      } catch (e) {
        logger.error('Failed to parse LLM response for create hive params:', modelResponse, e);
        throw new Error('Could not understand Hive creation parameters.');
      }

      // Parameter extraction with runtime settings fallback
      const podId = createHiveParams.podId;
      const hiveURI = createHiveParams.hiveURI;
      const hiveName = createHiveParams.name;

      // Validation - only check extracted parameters now, env vars already validated
      if (!podId) {
        const errMsg = 'AI Pod ID is required to create a Hive.';
        logger.error(`[createHiveAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ Error: ${errMsg}` });
        throw new Error(errMsg);
      }

      if (!hiveURI) {
        const errMsg = 'Hive URI is required to create a Hive.';
        logger.error(`[createHiveAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ Error: ${errMsg}` });
        throw new Error(errMsg);
      }

      const privateKey = runtime.getSetting('PRIVATE_KEY');
      const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL');

      // Initialize provider and wallet
      const provider = new JsonRpcProvider(rpcUrl);
      const wallet = new Wallet(privateKey, provider);
      const walletAddress = await wallet.getAddress();

      // Initialize contracts
      const podContract = new Contract(AI_POD_CONTRACT_ADDRESS, ERC721_ABI, provider);
      const hiveRegistryContract = new Contract(HIVE_REGISTRY_ADDRESS, HIVE_REGISTRY_ABI, wallet);

      logger.info(`[createHiveAction] Verifying AI Pod ownership...`);

      // Verify Pod ownership using standard ERC721 ownerOf
      const podOwner = await podContract.ownerOf(BigInt(podId));

      if (podOwner.toLowerCase() !== walletAddress.toLowerCase()) {
        const errMsg = `You must own the AI Pod to create a Hive. Current owner: ${podOwner}, Your address: ${walletAddress}`;
        logger.error(`[createHiveAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ Error: ${errMsg}` });
        throw new Error(errMsg);
      }

      logger.info(`[createHiveAction] Creating Hive with Pod ID ${podId}...`);

      // Create Hive by calling createHive function
      const tx = await hiveRegistryContract.createHive(BigInt(podId), hiveURI);

      logger.info(`[createHiveAction] Transaction submitted: ${tx.hash}`);

      // Wait for transaction confirmation
      const receipt = await tx.wait();

      if (!receipt || receipt.status !== 1) {
        throw new Error('Transaction failed or was reverted');
      }

      logger.info(`[createHiveAction] Transaction confirmed. Retrieving Hive ID...`);

      // Get the Hive ID using getHiveId function from the contract
      const hiveId = await hiveRegistryContract.getHiveId(BigInt(podId));

      logger.info(`[createHiveAction] Successfully created Hive. Hive ID: ${hiveId}`);

      let responseText = `🏘️ **Hive Successfully Created**\n\n`;
      responseText += `**Hive ID:** ${hiveId}\n`;
      responseText += `**Transaction Hash:** ${tx.hash}\n`;
      responseText += `**AI Pod ID:** ${podId}\n`;
      responseText += `**Hive URI:** ${hiveURI}\n`;
      if (hiveName) {
        responseText += `**Hive Name:** ${hiveName}\n`;
      }
      responseText += `**Block Number:** ${receipt.blockNumber}\n`;
      responseText += `**Gas Used:** ${receipt.gasUsed.toString()}\n\n`;
      responseText += `🔗 **Next Steps:** You can now link assets to your Hive and manage its metadata.\n`;
      responseText += `🔗 **View Transaction:** https://basescan.org/tx/${tx.hash}`;

      const responseContent: Content = {
        text: responseText,
        data: {
          hiveId: hiveId.toString(),
          txHash: tx.hash,
          podId,
          hiveURI,
          hiveName,
          hiveRegistryAddress: HIVE_REGISTRY_ADDRESS,
          podContractAddress: AI_POD_CONTRACT_ADDRESS,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[createHiveAction] Error:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error during Hive creation.';
      const errorContent: Content = {
        text: `❌ **Error creating Hive**: ${errorMessage}`,
        data: {
          error: errorMessage,
          podId: createHiveParams?.podId,
          hiveURI: createHiveParams?.hiveURI,
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
          text: 'Create a Hive using Pod ID 123 with metadata at https://example.com/hive-metadata.json via Alethea.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'I will create a new Hive using Pod ID 123 with the specified metadata URI via Alethea. Let me verify Pod ownership and execute the creation.',
          actions: ['ALETHEA_CREATE_HIVE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Make a new Hive called "AI Research Collective" using my Level 5 Pod 456, metadata should be ipfs://QmExample123... via Alethea',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Creating a new Hive named "AI Research Collective" using Pod 456 with IPFS metadata via Alethea.',
          actions: ['ALETHEA_CREATE_HIVE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Launch a Hive with Pod 789 and empty metadata for now via Alethea.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Launching a Hive with Pod 789 via Alethea. I will use an empty string for metadata which can be updated later.',
          actions: ['ALETHEA_CREATE_HIVE'],
        },
      },
    ],
  ],
};
