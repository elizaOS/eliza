import type { ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { type Address, encodeFunctionData, type Hex, keccak256, stringToHex } from "viem";
import governorArtifacts from "../contracts/artifacts/OZGovernor.json";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import { WalletProvider } from "../providers/wallet";
import { queueProposalTemplate } from "../templates";
import type { QueueProposalParams, SupportedChain, Transaction } from "../types";

export { queueProposalTemplate };

const spec = requireActionSpec("QUEUE_PROPOSAL");

export class QueueAction {
  constructor(private walletProvider: WalletProvider) {}

  async queue(params: QueueProposalParams): Promise<Transaction> {
    const walletClient = this.walletProvider.getWalletClient(params.chain);

    if (!walletClient.account) {
      throw new Error("Wallet account is not available");
    }

    const descriptionHash = keccak256(stringToHex(params.description));

    const txData = encodeFunctionData({
      abi: governorArtifacts.abi,
      functionName: "queue",
      args: [params.targets, params.values, params.calldatas, descriptionHash],
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
      throw new Error(`Queue failed: ${errorMessage}`);
    }
  }
}

export const queueAction = {
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
      if (
        !options.chain ||
        !options.governor ||
        !options.targets ||
        !options.values ||
        !options.calldatas ||
        !options.description
      ) {
        throw new Error("Missing required parameters for queue proposal");
      }

      const queueParams: QueueProposalParams = {
        chain: options.chain as SupportedChain,
        governor: options.governor as Address,
        targets: options.targets as Address[],
        values: (options.values as string[]).map((v) => BigInt(v)),
        calldatas: options.calldatas as `0x${string}`[],
        description: String(options.description),
      };

      const privateKey = runtime.getSetting("EVM_PRIVATE_KEY") as `0x${string}`;
      const walletProvider = new WalletProvider(privateKey, runtime);
      const action = new QueueAction(walletProvider);
      const result = await action.queue(queueParams);
      return {
        success: true,
        text: `Proposal queued successfully. Transaction hash: ${result.hash}`,
        data: {
          transactionHash: result.hash,
          from: result.from,
          to: result.to,
          chain: queueParams.chain,
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
  template: queueProposalTemplate,
  validate: async (runtime: IAgentRuntime) => {
    const privateKey = runtime.getSetting("EVM_PRIVATE_KEY");
    return typeof privateKey === "string" && privateKey.startsWith("0x");
  },
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Queue proposal 123 on the governor at 0x1234567890123456789012345678901234567890 on Ethereum",
          action: "QUEUE_PROPOSAL",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Queue the passed proposal for execution on governor 0xabcdef1234567890abcdef1234567890abcdef12 on Base",
          action: "QUEUE_PROPOSAL",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Add proposal 789 to the timelock queue on the DAO at 0x9876543210987654321098765432109876543210 on Arbitrum",
          action: "QUEUE_PROPOSAL",
        },
      },
    ],
  ],
  similes: spec.similes ? [...spec.similes] : [],
};
