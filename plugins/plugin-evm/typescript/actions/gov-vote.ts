import type { ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { type Address, encodeFunctionData, type Hex } from "viem";
import governorArtifacts from "../contracts/artifacts/OZGovernor.json";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import { WalletProvider } from "../providers/wallet";
import { voteTemplate } from "../templates";
import type { SupportedChain, Transaction, VoteParams } from "../types";

export { voteTemplate };

const spec = requireActionSpec("VOTE_PROPOSAL");

export class VoteAction {
  constructor(private walletProvider: WalletProvider) {}

  async vote(params: VoteParams): Promise<Transaction> {
    const walletClient = this.walletProvider.getWalletClient(params.chain);

    if (!walletClient.account) {
      throw new Error("Wallet account is not available");
    }

    const proposalId = BigInt(params.proposalId.toString());
    const support = BigInt(params.support.toString());

    const txData = encodeFunctionData({
      abi: governorArtifacts.abi,
      functionName: "castVote",
      args: [proposalId, support],
    });

    try {
      const chainConfig = this.walletProvider.getChainConfigs(params.chain);
      const publicClient = this.walletProvider.getPublicClient(params.chain);

      // @ts-expect-error - viem type narrowing issue with sendTransaction parameters
      const hash = await walletClient.sendTransaction({
        account: walletClient.account,
        to: params.governor,
        value: BigInt(0),
        data: txData as Hex,
        chain: chainConfig,
      });

      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
      });

      return {
        hash,
        from: walletClient.account?.address as `0x${string}`,
        to: params.governor,
        value: BigInt(0),
        data: txData as Hex,
        chainId: this.walletProvider.getChainConfigs(params.chain).id,
        logs: receipt.logs,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Vote failed: ${errorMessage}`);
    }
  }
}

export const voteAction = {
  name: spec.name,
  description: spec.description,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
    options: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      if (!options.chain || !options.governor || !options.proposalId || !options.support) {
        throw new Error("Missing required parameters for vote");
      }

      const voteParams: VoteParams = {
        chain: options.chain as SupportedChain,
        governor: options.governor as Address,
        proposalId: String(options.proposalId),
        support: Number(options.support),
      };

      const privateKey = runtime.getSetting("EVM_PRIVATE_KEY") as `0x${string}`;
      const walletProvider = new WalletProvider(privateKey, runtime);
      const action = new VoteAction(walletProvider);
      const result = await action.vote(voteParams);
      return {
        success: true,
        text: `Vote submitted successfully. Transaction hash: ${result.hash}`,
        data: {
          transactionHash: result.hash,
          from: result.from,
          to: result.to,
          chain: voteParams.chain,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (callback) {
        callback({ text: `Error: ${errorMessage}` });
      }
      return {
        success: false,
        text: `Error: ${errorMessage}`,
      };
    }
  },
  template: voteTemplate,
  validate: async (runtime: IAgentRuntime) => {
    const privateKey = runtime.getSetting("EVM_PRIVATE_KEY");
    return typeof privateKey === "string" && privateKey.startsWith("0x");
  },
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Vote yes on proposal 123 on the governor at 0x1234567890123456789012345678901234567890 on Ethereum",
          action: "GOVERNANCE_VOTE",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Vote no on proposal 456 on the governor at 0xabcdef1111111111111111111111111111111111 on Ethereum",
          action: "GOVERNANCE_VOTE",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Abstain from voting on proposal 789 on the governor at 0x0000111122223333444455556666777788889999 on Ethereum",
          action: "GOVERNANCE_VOTE",
        },
      },
    ],
  ],
  similes: spec.similes ? [...spec.similes] : [],
};
