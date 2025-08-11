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
import { convertInftToAliAgentTemplate } from '../templates';
import { ERC721_ABI, KEYS_FACTORY_ABI } from '../abis';
import { INFT_KEYS_FACTORY_ADDRESS } from '../constants';

// Interface for the parameters accepted by the convertInftToAliAgent action
interface ConvertInftToAliAgentParams {
  inftContract: string;
  inftTokenId: string;
  recipient?: string;
}

export const convertInftToAliAgentAction: Action = {
  name: 'ALETHEA_CONVERT_INFT_TO_ALI_AGENT',
  similes: ['CREATE_ALI_FROM_INFT', 'TOKENIZE_INFT', 'INFT_TO_ALI_AGENT'].map(
    (s) => `ALETHEA_${s}`
  ),
  description:
    'Convert an existing iNFT into an ALI Agent using the Alethea AI protocol (on Ethereum Mainnet).',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info(`[convertInftToAliAgentAction] Validate called.`);
    // Basic validation, detailed validation in handler
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[convertInftToAliAgentAction] Handler called.');

    let convertParams: ConvertInftToAliAgentParams | undefined;

    try {
      const prompt = composePromptFromState({
        state,
        template: convertInftToAliAgentTemplate as unknown as TemplateType,
      });

      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
      let paramsJson: ConvertInftToAliAgentParams | { error: string };

      try {
        paramsJson = parseJSONObjectFromText(modelResponse) as
          | ConvertInftToAliAgentParams
          | { error: string };
        logger.debug(
          '[convertInftToAliAgentAction] iNFT Convert parameters extracted:',
          paramsJson
        );
        if ('error' in paramsJson) {
          throw new Error(paramsJson.error);
        }
        convertParams = paramsJson;
      } catch (e) {
        logger.error(
          '[convertInftToAliAgentAction] Failed to parse LLM response for iNFT convert params:',
          modelResponse,
          e
        );
        throw new Error('Could not understand iNFT conversion parameters.');
      }

      const { inftContract, inftTokenId, recipient } = convertParams;
      const implementationType = 0; // For iNFT to ALI Agent conversion, type is 0 (ETH based, on Mainnet)

      const privateKey = runtime.getSetting('PRIVATE_KEY');
      const rpcUrl = 'https://eth-mainnet.g.alchemy.com/v2/leJZo772RgCTBqv4PdsHlb_CI68nxQiB'; // Assumed to be Ethereum RPC for this action

      if (!inftContract || !inftTokenId) {
        throw new Error('iNFT contract address and token ID are required.');
      }
      if (!privateKey || !rpcUrl) {
        throw new Error('PRIVATE_KEY and ALETHEA_RPC_URL (for Ethereum) are required.');
      }

      const provider = new JsonRpcProvider(rpcUrl);
      const wallet = new Wallet(privateKey, provider);
      const walletAddress = await wallet.getAddress();

      const inftContractInstance = new Contract(inftContract, ERC721_ABI, provider);
      const keysFactoryContract = new Contract(INFT_KEYS_FACTORY_ADDRESS, KEYS_FACTORY_ABI, wallet);

      logger.info('[convertInftToAliAgentAction] Verifying iNFT ownership...');
      const inftOwner = await inftContractInstance.ownerOf(inftTokenId);
      const actualRecipient = recipient || walletAddress;

      if (inftOwner.toLowerCase() !== walletAddress.toLowerCase()) {
        throw new Error(
          `Caller does not own the iNFT. Owner: ${inftOwner}, Caller: ${walletAddress}`
        );
      }

      logger.info(
        '[convertInftToAliAgentAction] Converting iNFT to ALI Agent via deploySharesContractPaused...'
      );
      const tx = await keysFactoryContract.deploySharesContractPaused(implementationType, {
        tokenAddress: inftContract,
        tokenId: inftTokenId,
      });

      logger.info(`[convertInftToAliAgentAction] Transaction submitted: ${tx.hash}`);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error('iNFT to ALI Agent conversion transaction failed or was reverted');
      }

      logger.info(
        '[convertInftToAliAgentAction] Transaction confirmed. Retrieving ALI Agent address...'
      );
      const aliAgentAddress = await keysFactoryContract.lookupSharesContract({
        tokenAddress: inftContract,
        tokenId: inftTokenId,
      });

      logger.info(
        `[convertInftToAliAgentAction] Successfully converted iNFT to ALI Agent. Agent Address: ${aliAgentAddress}`
      );

      const responseText =
        `🤖 **iNFT Successfully Converted to ALI Agent (on Ethereum)**\n\n` +
        `**ALI Agent Address (Keys Contract):** ${aliAgentAddress}\n` +
        `**Transaction Hash:** ${tx.hash}\n` +
        `**iNFT Contract:** ${inftContract}\n` +
        `**iNFT Token ID:** ${inftTokenId}\n` +
        `**Implementation Type:** ${implementationType} (ETH Mainnet standard)\n` +
        `**Block Number:** ${receipt.blockNumber}\n` +
        `**Gas Used:** ${receipt.gasUsed.toString()}\n\n` +
        `🔑 **Keys Trading:** You can now buy/sell keys for this ALI Agent using its address: ${aliAgentAddress}.\n` +
        `🔗 **View Transaction on Etherscan:** https://etherscan.io/tx/${tx.hash}`;

      const responseContent: Content = {
        text: responseText,
        data: {
          aliAgentId: aliAgentAddress,
          aliAgentAddress: aliAgentAddress,
          keysContractAddress: aliAgentAddress,
          txHash: tx.hash,
          inftContract,
          inftTokenId,
          implementationType,
          recipient: actualRecipient,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          network: 'ethereum', // Indicate network context
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[convertInftToAliAgentAction] Error:', error);
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Unknown error occurred during iNFT to ALI Agent conversion.';
      const errorContent: Content = {
        text: `❌ **Error converting iNFT to ALI Agent**: ${errorMessage}`,
        data: {
          error: errorMessage,
          inftContract: convertParams?.inftContract,
          inftTokenId: convertParams?.inftTokenId,
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
          text: 'Convert my iNFT 0xabcdef...1234 token ID 777 into an ALI Agent on Ethereum via Alethea.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "Okay, I'll convert your iNFT into an ALI Agent on Ethereum via Alethea. This will use the standard ETH-based implementation (type 0).",
          actions: ['ALETHEA_CONVERT_INFT_TO_ALI_AGENT'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Tokenize my iNFT collection_address token_id for my_friend_address via Alethea.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Converting your iNFT to an ALI Agent via Alethea and assigning ownership to your_friend_address. This will be on Ethereum.',
          actions: ['ALETHEA_CONVERT_INFT_TO_ALI_AGENT'],
        },
      },
    ],
  ],
};
