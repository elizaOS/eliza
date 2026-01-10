// @ts-nocheck
import type {
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { type Address, encodeFunctionData, type Hex } from "viem";
import governorArtifacts from "../contracts/artifacts/OZGovernor.json";
import { WalletProvider } from "../providers/wallet";
import { proposeTemplate } from "../templates";
import type {
  ProposeProposalParams,
  SupportedChain,
  Transaction,
} from "../types";

export { proposeTemplate };

export class ProposeAction {
  constructor(private walletProvider: WalletProvider) {
    this.walletProvider = walletProvider;
  }

  async propose(params: ProposeProposalParams): Promise<Transaction> {
    const walletClient = this.walletProvider.getWalletClient(params.chain);

    if (!walletClient.account) {
      throw new Error("Wallet account is not available");
    }

    const txData = encodeFunctionData({
      abi: governorArtifacts.abi,
      functionName: "propose",
      args: [
        params.targets,
        params.values,
        params.calldatas,
        params.description,
      ],
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

export const proposeAction = {
  name: "propose",
  description: "Execute a DAO governance proposal",
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
        throw new Error("Missing required parameters for proposal");
      }

      // Convert options to ProposeProposalParams
      const proposeParams: ProposeProposalParams = {
        chain: options.chain as SupportedChain,
        governor: options.governor as Address,
        targets: options.targets as Address[],
        values: (options.values as string[]).map((v) => BigInt(v)),
        calldatas: options.calldatas as `0x${string}`[],
        description: String(options.description),
      };

      const privateKey = runtime.getSetting("EVM_PRIVATE_KEY") as `0x${string}`;
      const walletProvider = new WalletProvider(privateKey, runtime);
      const action = new ProposeAction(walletProvider);
      return await action.propose(proposeParams);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("Error in propose handler:", errorMessage);
      if (callback) {
        callback({ text: `Error: ${errorMessage}` });
      }
      return false;
    }
  },
  template: proposeTemplate,
  validate: async (runtime: IAgentRuntime) => {
    const privateKey = runtime.getSetting("EVM_PRIVATE_KEY");
    return typeof privateKey === "string" && privateKey.startsWith("0x");
  },
  examples: [
    [
      {
        user: "user",
        content: {
          text: "Propose transferring 1e18 tokens on the governor at 0x1234567890123456789012345678901234567890 on Ethereum",
          action: "PROPOSE",
        },
      },
    ],
  ],
  similes: ["PROPOSE", "GOVERNANCE_PROPOSE"],
}; // TODO: add more examples
