import type {
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  type Address,
  encodeFunctionData,
  type Hex,
  keccak256,
  stringToHex,
} from "viem";
import governorArtifacts from "../contracts/artifacts/OZGovernor.json";
import { WalletProvider } from "../providers/wallet";
import { queueProposalTemplate } from "../templates";
import type {
  QueueProposalParams,
  SupportedChain,
  Transaction,
} from "../types";

export { queueProposalTemplate };

export class QueueAction {
  constructor(private walletProvider: WalletProvider) {
    this.walletProvider = walletProvider;
  }

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

      // Log current block before sending transaction
      const publicClient = this.walletProvider.getPublicClient(params.chain);

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
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Vote failed: ${errorMessage}`);
    }
  }
}

export const queueAction = {
  name: "queue",
  description: "Queue a DAO governance proposal for execution",
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
    options: Record<string, unknown>,
    callback?: HandlerCallback,
  ) => {
    try {
      // Validate required fields
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

      // Convert options to QueueProposalParams
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
      return await action.queue(queueParams);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("Error in queue handler:", errorMessage);
      if (callback) {
        callback({ text: `Error: ${errorMessage}` });
      }
      return false;
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
        user: "user",
        content: {
          text: "Queue proposal 123 on the governor at 0x1234567890123456789012345678901234567890 on Ethereum",
          action: "QUEUE_PROPOSAL",
        },
      },
    ],
  ],
  similes: ["QUEUE_PROPOSAL", "GOVERNANCE_QUEUE"],
}; // TODO: add more examples
