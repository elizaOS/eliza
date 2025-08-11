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
import { Contract, JsonRpcProvider, Wallet, MaxUint256 } from 'ethers';
import { fusePodWithAliAgentTemplate } from '../templates';
import { TRADEABLE_SHARES_ABI, ERC721_ABI } from '../abis';
import { DEFAULT_POD_NFT_CONTRACT_ADDRESS } from '../constants';

interface FusePodWithAliAgentParams {
  agentId: string; // ALI Agent ID (SharesContract address)
  podId: string; // Token ID of the Pod NFT
  podContractAddress?: string; // Optional contract address of the Pod NFT
}

export const fusePodWithAliAgentAction: Action = {
  name: 'ALETHEA_FUSE_POD_WITH_ALI_AGENT',
  similes: ['FUSE_POD', 'ATTACH_POD_TO_AGENT', 'LINK_POD_TO_AGENT', 'UPGRADE_AGENT_WITH_POD'].map(
    (s) => `ALETHEA_${s}`
  ),
  description: 'Fuse a Level 5 Pod NFT with an ALI Agent. Requires Pod ownership and approval.',
  validate: async () => true,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[fusePodWithAliAgentAction] Handler called.');
    let params: FusePodWithAliAgentParams | undefined;
    try {
      const prompt = composePromptFromState({
        state,
        template: fusePodWithAliAgentTemplate as unknown as TemplateType,
      });
      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
      const parsed = parseJSONObjectFromText(modelResponse) as
        | FusePodWithAliAgentParams
        | { error: string };

      if ('error' in parsed) {
        logger.warn(`[fusePodWithAliAgentAction] Model responded with error: ${parsed.error}`);
        throw new Error(parsed.error);
      }
      params = parsed;

      const { agentId, podId } = params;
      let { podContractAddress } = params;

      const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL');
      const privateKey = runtime.getSetting('PRIVATE_KEY');
      const defaultPodAddressFromSettings = runtime.getSetting('POD_NFT_CONTRACT_ADDRESS');

      if (!agentId || !podId) {
        throw new Error('ALI Agent ID and Pod ID are required.');
      }
      if (!rpcUrl || !privateKey) {
        throw new Error('ALETHEA_RPC_URL and PRIVATE_KEY are required in agent settings.');
      }

      if (!podContractAddress) {
        if (
          defaultPodAddressFromSettings &&
          defaultPodAddressFromSettings !== 'YOUR_DEFAULT_POD_NFT_CONTRACT_ADDRESS_HERE'
        ) {
          podContractAddress = defaultPodAddressFromSettings;
          logger.info(
            `[fusePodWithAliAgentAction] Using Pod NFT contract address from settings: ${podContractAddress}`
          );
        } else if (
          DEFAULT_POD_NFT_CONTRACT_ADDRESS !== 'YOUR_DEFAULT_POD_NFT_CONTRACT_ADDRESS_HERE'
        ) {
          podContractAddress = DEFAULT_POD_NFT_CONTRACT_ADDRESS;
          logger.info(
            `[fusePodWithAliAgentAction] Using default Pod NFT contract address from constants: ${podContractAddress}`
          );
        } else {
          throw new Error(
            'Pod NFT Contract Address is required. Please provide it or set POD_NFT_CONTRACT_ADDRESS in settings.'
          );
        }
      }
      if (
        !podContractAddress ||
        podContractAddress === 'YOUR_DEFAULT_POD_NFT_CONTRACT_ADDRESS_HERE'
      ) {
        throw new Error('Pod NFT Contract Address is not configured correctly.');
      }

      const actualPodId = BigInt(podId);

      const provider = new JsonRpcProvider(rpcUrl);
      const wallet = new Wallet(privateKey, provider);
      const walletAddress = await wallet.getAddress();

      const sharesContract = new Contract(agentId, TRADEABLE_SHARES_ABI, wallet);
      const podNftContract = new Contract(podContractAddress, ERC721_ABI, wallet);

      logger.info(
        `[fusePodWithAliAgentAction] Verifying ownership of Pod NFT ${podContractAddress} token ${podId}...`
      );
      const podOwner = await podNftContract.ownerOf(actualPodId);
      if (podOwner.toLowerCase() !== walletAddress.toLowerCase()) {
        throw new Error(
          `Caller does not own Pod NFT ${podId} from contract ${podContractAddress}. Owner: ${podOwner}`
        );
      }
      logger.info('[fusePodWithAliAgentAction] Pod NFT ownership verified.');

      logger.info(
        `[fusePodWithAliAgentAction] Checking Pod NFT ${podId} approval for ALI Agent ${agentId}...`
      );
      const approvedAddress = await podNftContract.getApproved(actualPodId);
      const isApprovedForAll = await podNftContract.isApprovedForAll(walletAddress, agentId);

      if (approvedAddress?.toLowerCase() !== agentId.toLowerCase() && !isApprovedForAll) {
        logger.info(
          `[fusePodWithAliAgentAction] Pod NFT not approved. Approving Pod NFT ${podId} for ALI Agent ${agentId}...`
        );
        const approveTx = await podNftContract.approve(agentId, actualPodId);
        logger.info(
          `[fusePodWithAliAgentAction] Approval transaction submitted: ${approveTx.hash}. Waiting for confirmation...`
        );
        const approveReceipt = await approveTx.wait();
        if (!approveReceipt || approveReceipt.status !== 1) {
          throw new Error(
            `Pod NFT approval transaction failed or was reverted. Hash: ${approveTx.hash}`
          );
        }
        logger.info('[fusePodWithAliAgentAction] Pod NFT approval confirmed.');
      } else {
        logger.info('[fusePodWithAliAgentAction] Pod NFT already approved.');
      }

      // The ticket mentions Level 5 Pod. This check should ideally happen on-chain via a Pod contract view function.
      // Since no such function is specified, we are proceeding with fuse. Add warning.
      logger.warn(
        '[fusePodWithAliAgentAction] IMPORTANT: This action assumes the Pod NFT is Level 5. On-chain level verification is not implemented.'
      );

      logger.info(`[fusePodWithAliAgentAction] Fusing Pod ${podId} with ALI Agent ${agentId}...`);
      const fuseTx = await sharesContract.fusePod(actualPodId);
      logger.info(
        `[fusePodWithAliAgentAction] Fuse Pod transaction submitted: ${fuseTx.hash}. Waiting for confirmation...`
      );
      const fuseReceipt = await fuseTx.wait();

      if (!fuseReceipt || fuseReceipt.status !== 1) {
        throw new Error(`Fuse Pod transaction failed or was reverted. Hash: ${fuseTx.hash}`);
      }
      logger.info('[fusePodWithAliAgentAction] Fuse Pod transaction confirmed.');

      // The ticket mentions `updatedAgentMetadata` but `fusePod` doesn't return it directly.
      // Metadata would be updated on-chain and might need a separate query if details are required.
      const responseText =
        `✅ **Successfully Fused Pod with ALI Agent**\n\n` +
        `**ALI Agent ID:** ${agentId}\n` +
        `**Pod NFT Contract:** ${podContractAddress}\n` +
        `**Pod ID Fused:** ${podId}\n` +
        `**Transaction Hash:** ${fuseTx.hash}\n\n` +
        `ℹ️ The ALI Agent's metadata should now be updated on-chain reflecting the fusion.\n` +
        `🔗 **View Transaction:** https://basescan.org/tx/${fuseTx.hash}`;

      const responseContent: Content = {
        text: responseText,
        data: {
          agentId,
          podContractAddress,
          podId,
          txHash: fuseTx.hash,
          blockNumber: fuseReceipt.blockNumber,
          gasUsed: fuseReceipt.gasUsed.toString(),
          timestamp: new Date().toISOString(),
          notes:
            'Agent metadata updated on-chain. Specific updated metadata not returned by this transaction.',
        },
      };
      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[fusePodWithAliAgentAction] Error:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error during Pod fusion.';
      const errorContent: Content = {
        text: `❌ **Error fusing Pod with ALI Agent**: ${errorMessage}`,
        data: {
          error: errorMessage,
          agentId: params?.agentId,
          podId: params?.podId,
          podContractAddress: params?.podContractAddress,
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
          text: 'Fuse pod 123 from contract 0xPodContract... with my ALI agent 0xAgentAddress... via Alethea',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Okay, attempting to fuse Pod 123 with ALI Agent 0xAgentAddress... via Alethea. I will verify ownership and approval first.',
          actions: ['ALETHEA_FUSE_POD_WITH_ALI_AGENT'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Attach pod ID 789 to agent 0xAgentXYZ via Alethea. The pod is at the default address.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Understood. Fusing Pod 789 (from default Pod contract) with ALI Agent 0xAgentXYZ... via Alethea',
          actions: ['ALETHEA_FUSE_POD_WITH_ALI_AGENT'],
        },
      },
    ],
  ],
};
