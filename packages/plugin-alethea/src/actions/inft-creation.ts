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
import { createInftTemplate } from '../templates/inft-creation';
import { ALI_TOKEN_ADDRESS_ETHEREUM, INTELLIGENT_NFT_V2_ADDRESS } from '../constants';
import { ALI_TOKEN_ERC20_ABI, INTELLIGENT_NFT_V2_ABI, ERC721_ABI } from '../abis';

interface CreateInftParams {
  nftContract: string;
  nftId: string;
  podContract: string;
  podId: string;
  aliValue: string;
}

export const createInftAction: Action = {
  name: 'ALETHEA_CREATE_INFT',
  similes: ['GENERATE_INFT', 'MINT_INFT', 'FUSE_NFT_WITH_POD'].map((s) => `ALETHEA_${s}`),
  description: 'Create an iNFT by fusing an NFT with a Personality Pod.',

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    logger.info('[createInftAction] Validate called.');
    if (!runtime.getSetting('PRIVATE_KEY') || !runtime.getSetting('ALETHEA_RPC_URL')) {
      logger.error('[createInftAction] PRIVATE_KEY and ALETHEA_RPC_URL are required.');
      return false;
    }
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[createInftAction] Handler called.');
    let params: CreateInftParams | undefined;

    try {
      const prompt = composePromptFromState({
        state,
        template: createInftTemplate as unknown as TemplateType,
      });
      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
      const parsedParams = parseJSONObjectFromText(modelResponse) as
        | CreateInftParams
        | { error: string };

      if ('error' in parsedParams) throw new Error(`Model error: ${parsedParams.error}`);
      params = parsedParams;
      const { nftContract, nftId, podContract, podId, aliValue } = params;

      const privateKey = runtime.getSetting('PRIVATE_KEY') as string;
      const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL') as string;
      const provider = new JsonRpcProvider(rpcUrl);
      const wallet = new Wallet(privateKey, provider);

      const intelligentNftContract = new Contract(
        INTELLIGENT_NFT_V2_ADDRESS,
        INTELLIGENT_NFT_V2_ABI,
        wallet
      );
      const baseNftContract = new Contract(nftContract, ERC721_ABI, wallet);
      const podNftContract = new Contract(podContract, ERC721_ABI, wallet);
      const aliTokenContract = new Contract(
        ALI_TOKEN_ADDRESS_ETHEREUM,
        ALI_TOKEN_ERC20_ABI,
        wallet
      );

      if ((await baseNftContract.ownerOf(nftId)).toLowerCase() !== wallet.address.toLowerCase())
        throw new Error('You are not the owner of the base NFT.');
      if ((await podNftContract.ownerOf(podId)).toLowerCase() !== wallet.address.toLowerCase())
        throw new Error('You are not the owner of the Personality Pod.');

      const aliAmountWei = ethers.parseEther(aliValue);
      if ((await aliTokenContract.balanceOf(wallet.address)) < aliAmountWei)
        throw new Error('Insufficient ALI balance.');

      if (
        !(await podNftContract.isApprovedForAll(wallet.address, INTELLIGENT_NFT_V2_ADDRESS)) &&
        (await podNftContract.getApproved(podId)).toLowerCase() !==
          INTELLIGENT_NFT_V2_ADDRESS.toLowerCase()
      ) {
        logger.info(`Approving Personality Pod ${podId} for fusion...`);
        const approveTx = await podNftContract.approve(INTELLIGENT_NFT_V2_ADDRESS, podId);
        await approveTx.wait();
      }

      if (
        (await aliTokenContract.allowance(wallet.address, INTELLIGENT_NFT_V2_ADDRESS)) <
        aliAmountWei
      ) {
        logger.info(`Approving ${aliValue} ALI for fusion...`);
        const approveTx = await aliTokenContract.approve(INTELLIGENT_NFT_V2_ADDRESS, aliAmountWei);
        await approveTx.wait();
      }

      const recordId = await intelligentNftContract.totalSupply();

      logger.info(`Fusing NFTs to create iNFT with recordId ${recordId}...`);
      const mintTx = await intelligentNftContract.mint(
        recordId,
        aliAmountWei,
        podContract,
        podId,
        nftContract,
        nftId
      );
      const txReceipt = await mintTx.wait();

      const iNftInterface = new Interface(INTELLIGENT_NFT_V2_ABI);
      const mintedEvent = txReceipt.logs
        .map((log: any) => {
          try {
            return iNftInterface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((log: any) => log && log.name === 'Minted');

      if (!mintedEvent) throw new Error('Could not confirm iNFT creation from transaction logs.');

      const newInftId = mintedEvent.args._recordId.toString();

      const responseText =
        `✅ **iNFT Created Successfully!**\n\n` +
        `**iNFT ID:** ${newInftId}\n` +
        `**Transaction Hash:** ${txReceipt.hash}`;

      const responseContent: Content = {
        text: responseText,
        data: { inftId: newInftId, txHash: txReceipt.hash },
      };
      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[createInftAction] Error:', error);
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error creating iNFT**: ${errorMessage}`,
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
        content: { text: 'Fuse my NFT 1 from 0x... with Pod 2 from 0x... and 50 ALI via Alethea.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Initiating iNFT fusion via Alethea...',
          actions: ['ALETHEA_CREATE_INFT'],
        },
      },
    ],
  ],
};
