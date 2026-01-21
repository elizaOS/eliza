import type { ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { type Address, encodeFunctionData, type Hex, keccak256, stringToHex } from "viem";
import governorArtifacts from "../contracts/artifacts/OZGovernor.json";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import { WalletProvider } from "../providers/wallet";
import { executeProposalTemplate } from "../templates";
import type { ExecuteProposalParams, SupportedChain, Transaction } from "../types";

export { executeProposalTemplate };

export class ExecuteAction {
  constructor(private walletProvider: WalletProvider) {}

  async execute(params: ExecuteProposalParams): Promise<Transaction> {
    const walletClient = this.walletProvider.getWalletClient(params.chain);

    if (!walletClient.account) {
      throw new Error("Wallet account is not available");
    }

    const descriptionHash = keccak256(stringToHex(params.description));

    const txData = encodeFunctionData({
      abi: governorArtifacts.abi,
      functionName: "execute",
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
      throw new Error(`Execute failed: ${errorMessage}`);
    }
  }
}

const spec = requireActionSpec("GOV_EXECUTE");

export const executeAction = {
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
        !options.proposalId ||
        !options.targets ||
        !options.values ||
        !options.calldatas ||
        !options.description
      ) {
        throw new Error("Missing required parameters for execute proposal");
      }

      const executeParams: ExecuteProposalParams = {
        chain: options.chain as SupportedChain,
        governor: options.governor as Address,
        proposalId: String(options.proposalId),
        targets: options.targets as Address[],
        values: (options.values as string[]).map((v) => BigInt(v)),
        calldatas: options.calldatas as `0x${string}`[],
        description: String(options.description),
      };

      const privateKey = runtime.getSetting("EVM_PRIVATE_KEY") as `0x${string}`;
      const walletProvider = new WalletProvider(privateKey, runtime);
      const action = new ExecuteAction(walletProvider);
      const result = await action.execute(executeParams);
      return {
        success: true,
        text: `Proposal executed successfully. Transaction hash: ${result.hash}`,
        data: {
          transactionHash: result.hash,
          from: result.from,
          to: result.to,
          chain: executeParams.chain,
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
  template: executeProposalTemplate,
  validate: async (runtime: IAgentRuntime) => {
    const privateKey = runtime.getSetting("EVM_PRIVATE_KEY");
    return typeof privateKey === "string" && privateKey.startsWith("0x");
  },
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Execute proposal 123 on the governor at 0x1234567890123456789012345678901234567890 on Ethereum",
          action: "EXECUTE_PROPOSAL",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Execute the passed proposal on governor 0xabcdef1234567890abcdef1234567890abcdef12 on Base",
          action: "EXECUTE_PROPOSAL",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Run the execution for proposal ID 456 on the DAO governor at 0x9876543210987654321098765432109876543210 on Arbitrum",
          action: "EXECUTE_PROPOSAL",
        },
      },
    ],
  ],
  similes: spec.similes ? [...spec.similes] : [],
};
