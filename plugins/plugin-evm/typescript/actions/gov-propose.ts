import type { ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { type Address, encodeFunctionData, type Hex } from "viem";
import governorArtifacts from "../contracts/artifacts/OZGovernor.json";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import { WalletProvider } from "../providers/wallet";
import { proposeTemplate } from "../templates";
import type { ProposeProposalParams, SupportedChain, Transaction } from "../types";

export { proposeTemplate };

export class ProposeAction {
  constructor(private walletProvider: WalletProvider) {}

  async propose(params: ProposeProposalParams): Promise<Transaction> {
    const walletClient = this.walletProvider.getWalletClient(params.chain);

    if (!walletClient.account) {
      throw new Error("Wallet account is not available");
    }

    const txData = encodeFunctionData({
      abi: governorArtifacts.abi,
      functionName: "propose",
      args: [params.targets, params.values, params.calldatas, params.description],
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
      throw new Error(`Proposal failed: ${errorMessage}`);
    }
  }
}

const spec = requireActionSpec("GOV_PROPOSE");

export const proposeAction = {
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
        throw new Error("Missing required parameters for proposal");
      }

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
      const result = await action.propose(proposeParams);
      return {
        success: true,
        text: `Proposal submitted successfully. Transaction hash: ${result.hash}`,
        data: {
          transactionHash: result.hash,
          from: result.from,
          to: result.to,
          chain: proposeParams.chain,
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
  template: proposeTemplate,
  validate: async (runtime: IAgentRuntime) => {
    const privateKey = runtime.getSetting("EVM_PRIVATE_KEY");
    return typeof privateKey === "string" && privateKey.startsWith("0x");
  },
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Propose transferring 1e18 tokens on the governor at 0x1234567890123456789012345678901234567890 on Ethereum",
          action: "PROPOSE",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Create a new proposal to update the fee structure on governor 0xabcdef1234567890abcdef1234567890abcdef12 on Base",
          action: "PROPOSE",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Submit a governance proposal for treasury allocation on the DAO at 0x9876543210987654321098765432109876543210 on Arbitrum",
          action: "PROPOSE",
        },
      },
    ],
  ],
  similes: spec.similes ? [...spec.similes] : [],
};
