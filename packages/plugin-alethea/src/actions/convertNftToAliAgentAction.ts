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
import {
  convertNftToAliAgentTemplate,
  convertInftToAliAgentTemplate,
  getAliAgentKeyBuyPriceTemplate,
} from '../templates';
import { ERC721_ABI, KEYS_FACTORY_ABI, TRADEABLE_SHARES_ABI } from '../abis';
import {
  KEYS_FACTORY_ADDRESS,
  DEFAULT_IMPLEMENTATION_TYPE,
  INFT_KEYS_FACTORY_ADDRESS,
  ALI_TOKEN_ADDRESS,
} from '../constants';

// Interface for the parameters accepted by the action
interface ConvertNftToAliAgentParams {
  nftContract: string;
  tokenId: string;
  recipient?: string;
  implementationType?: number; // 0 = ETH, 1 = ALI (see IMPLEMENTATION_TYPES in constants)
}

export const convertNftToAliAgentAction: Action = {
  name: 'ALETHEA_CONVERT_NFT_TO_ALI_AGENT',
  similes: ['CREATE_ALI_AGENT', 'TOKENIZE_NFT', 'NFT_TO_ALI_AGENT', 'CONVERT_NFT_TO_AGENT'].map(
    (s) => `ALETHEA_${s}`
  ),
  description: 'Convert an existing ERC-721 NFT into an ALI Agent using the Alethea AI protocol.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info(`[convertNftToAliAgentAction] Validate called.`);
    logger.info(
      '[convertNftToAliAgentAction] Basic validation passed (detailed validation in handler).'
    );
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[convertNftToAliAgentAction] Handler called.');

    let convertParams: ConvertNftToAliAgentParams | undefined;

    try {
      // Use LLM to extract parameters from natural language
      const prompt = composePromptFromState({
        state,
        template: convertNftToAliAgentTemplate as unknown as TemplateType,
      });

      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      let paramsJson: ConvertNftToAliAgentParams | { error: string };

      try {
        paramsJson = parseJSONObjectFromText(modelResponse) as
          | ConvertNftToAliAgentParams
          | { error: string };
        logger.debug('Convert NFT parameters extracted:', paramsJson);

        // Check if the model response contains an error
        if ('error' in paramsJson) {
          logger.warn(`Convert NFT action: Model responded with error: ${paramsJson.error}`);
          throw new Error(paramsJson.error);
        }

        // At this point, paramsJson must be ConvertNftToAliAgentParams
        convertParams = paramsJson;
      } catch (e) {
        logger.error('Failed to parse LLM response for convert NFT params:', modelResponse, e);
        throw new Error('Could not understand NFT conversion parameters.');
      }

      // Parameter extraction with runtime settings fallback
      const nftContract = convertParams.nftContract;
      const tokenId = convertParams.tokenId;
      const recipient = convertParams.recipient;
      const implementationType = convertParams.implementationType ?? DEFAULT_IMPLEMENTATION_TYPE;

      const privateKey = runtime.getSetting('PRIVATE_KEY');
      const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL');

      // Validation
      if (!nftContract) {
        const errMsg = 'NFT contract address is required to convert NFT to ALI Agent.';
        logger.error(`[convertNftToAliAgentAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ Error: ${errMsg}` });
        throw new Error(errMsg);
      }

      if (!tokenId) {
        const errMsg = 'NFT token ID is required to convert NFT to ALI Agent.';
        logger.error(`[convertNftToAliAgentAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ Error: ${errMsg}` });
        throw new Error(errMsg);
      }

      if (!privateKey) {
        const errMsg =
          'PRIVATE_KEY is required for NFT conversion. Please set it in agent settings.';
        logger.error(`[convertNftToAliAgentAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ Error: ${errMsg}` });
        throw new Error(errMsg);
      }

      if (!rpcUrl) {
        const errMsg =
          'ALETHEA_RPC_URL is required for NFT conversion. Please set it in agent settings.';
        logger.error(`[convertNftToAliAgentAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ Error: ${errMsg}` });
        throw new Error(errMsg);
      }

      // Initialize provider and wallet
      const provider = new JsonRpcProvider(rpcUrl);
      const wallet = new Wallet(privateKey, provider);
      const walletAddress = await wallet.getAddress();

      // Initialize contracts
      const nftContractInstance = new Contract(nftContract, ERC721_ABI, provider);
      const keysFactoryContract = new Contract(KEYS_FACTORY_ADDRESS, KEYS_FACTORY_ABI, wallet);

      logger.info(`[convertNftToAliAgentAction] Verifying NFT ownership...`);

      // Verify NFT ownership
      const nftOwner = await nftContractInstance.ownerOf(tokenId);
      const actualRecipient = recipient || walletAddress;

      if (nftOwner.toLowerCase() !== walletAddress.toLowerCase()) {
        const errMsg = `You must own the NFT to convert it. Current owner: ${nftOwner}, Your address: ${walletAddress}`;
        logger.error(`[convertNftToAliAgentAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ Error: ${errMsg}` });
        throw new Error(errMsg);
      }

      logger.info(`[convertNftToAliAgentAction] Converting NFT to ALI Agent...`);

      // Convert NFT into ALI Agent by calling deploySharesContract
      const tx = await keysFactoryContract.deploySharesContract(implementationType, {
        tokenAddress: nftContract,
        tokenId: tokenId,
      });

      logger.info(`[convertNftToAliAgentAction] Transaction submitted: ${tx.hash}`);

      // Wait for transaction confirmation
      const receipt = await tx.wait();

      if (!receipt || receipt.status !== 1) {
        throw new Error('Transaction failed or was reverted');
      }

      logger.info(
        `[convertNftToAliAgentAction] Transaction confirmed. Retrieving ALI Agent address...`
      );

      // Get the actual ALI Agent (shares contract) address using lookupSharesContract
      const aliAgentAddress = await keysFactoryContract.lookupSharesContract({
        tokenAddress: nftContract,
        tokenId: tokenId,
      });

      logger.info(
        `[convertNftToAliAgentAction] Successfully converted NFT to ALI Agent. Agent Address: ${aliAgentAddress}`
      );

      let responseText = `🤖 **NFT Successfully Converted to ALI Agent**\n\n`;
      responseText += `**ALI Agent Address (Keys Contract):** ${aliAgentAddress}\n`;
      responseText += `**Transaction Hash:** ${tx.hash}\n`;
      responseText += `**NFT Contract:** ${nftContract}\n`;
      responseText += `**Token ID:** ${tokenId}\n`;
      responseText += `**Implementation Type:** ${implementationType === 0 ? 'ETH' : 'ALI'}\n`;
      responseText += `**Block Number:** ${receipt.blockNumber}\n`;
      responseText += `**Gas Used:** ${receipt.gasUsed.toString()}\n\n`;
      responseText += `🔑 **Keys Trading:** You can now buy/sell keys for this ALI Agent using its address: ${aliAgentAddress}.\n`;
      responseText += `🔗 **View Transaction:** https://basescan.org/tx/${tx.hash}`;

      const responseContent: Content = {
        text: responseText,
        data: {
          aliAgentId: aliAgentAddress, // This is the real ALI Agent contract address
          aliAgentAddress: aliAgentAddress,
          keysContractAddress: aliAgentAddress, // The ALI Agent address is also the Keys contract
          txHash: tx.hash,
          nftContract,
          tokenId,
          implementationType,
          recipient: actualRecipient,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[convertNftToAliAgentAction] Error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error converting NFT to ALI Agent**: ${errorMessage}`,
        data: {
          error: errorMessage,
          nftContract: convertParams?.nftContract,
          tokenId: convertParams?.tokenId,
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
          text: 'Convert my NFT at contract 0x1234567890abcdef1234567890abcdef12345678 token ID 42 into an ALI Agent via Alethea',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll convert your NFT into an ALI Agent via Alethea. This will create a new intelligent agent backed by your NFT with embedded liquidity through its keys contract.",
          actions: ['ALETHEA_CONVERT_NFT_TO_ALI_AGENT'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Tokenize my bored ape yacht club NFT for me via Alethea.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Understood. I am converting your NFT to an ALI Agent via Alethea.',
          actions: ['ALETHEA_CONVERT_NFT_TO_ALI_AGENT'],
        },
      },
    ],
  ],
};
