import type { ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { type Address, encodeFunctionData, type Hex, keccak256, stringToHex } from "viem";
import governorArtifacts from "../contracts/artifacts/OZGovernor.json";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import { WalletProvider } from "../providers/wallet";
import type {
  ExecuteProposalParams,
  ProposeProposalParams,
  QueueProposalParams,
  SupportedChain,
  Transaction,
  VoteParams,
} from "../types";
import {
  buildSendTxParams,
  confirmationRequired,
  createEvmActionValidator,
  isConfirmed,
} from "./helpers";

type GovOp = "propose" | "vote" | "queue" | "execute";

interface GovOpParamsBase {
  readonly chain: SupportedChain;
  readonly governor: Address;
}

async function sendGovTx(
  walletProvider: WalletProvider,
  chain: SupportedChain,
  governor: Address,
  data: Hex
): Promise<Transaction> {
  const walletClient = walletProvider.getWalletClient(chain);
  const account = walletClient.account;
  if (!account) {
    throw new Error("Wallet account is not available");
  }

  const chainConfig = walletProvider.getChainConfigs(chain);
  const publicClient = walletProvider.getPublicClient(chain);

  const hash = await walletClient.sendTransaction(
    buildSendTxParams({
      account,
      to: governor,
      value: BigInt(0),
      data,
      chain: chainConfig,
    })
  );

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  return {
    hash,
    from: account.address,
    to: governor,
    value: BigInt(0),
    data,
    chainId: chainConfig.id,
    logs: receipt.logs,
  };
}

function encodeProposeData(params: ProposeProposalParams): Hex {
  return encodeFunctionData({
    abi: governorArtifacts.abi,
    functionName: "propose",
    args: [params.targets, params.values, params.calldatas, params.description],
  }) as Hex;
}

function encodeVoteData(params: VoteParams): Hex {
  return encodeFunctionData({
    abi: governorArtifacts.abi,
    functionName: "castVote",
    args: [BigInt(params.proposalId), BigInt(params.support)],
  }) as Hex;
}

function encodeQueueData(params: QueueProposalParams): Hex {
  const descriptionHash = keccak256(stringToHex(params.description));
  return encodeFunctionData({
    abi: governorArtifacts.abi,
    functionName: "queue",
    args: [params.targets, params.values, params.calldatas, descriptionHash],
  }) as Hex;
}

function encodeExecuteData(params: ExecuteProposalParams): Hex {
  const descriptionHash = keccak256(stringToHex(params.description));
  return encodeFunctionData({
    abi: governorArtifacts.abi,
    functionName: "execute",
    args: [params.targets, params.values, params.calldatas, descriptionHash],
  }) as Hex;
}

function readGovOp(options: Record<string, unknown> | undefined): GovOp {
  const op = String(options?.op ?? "").toLowerCase();
  if (op === "propose" || op === "vote" || op === "queue" || op === "execute") {
    return op;
  }
  throw new Error(
    "Missing or invalid 'op' parameter (expected 'propose' | 'vote' | 'queue' | 'execute')"
  );
}

function readBase(options: Record<string, unknown>): GovOpParamsBase {
  if (!options.chain || !options.governor) {
    throw new Error("Missing required 'chain' or 'governor' parameter");
  }
  return {
    chain: options.chain as SupportedChain,
    governor: options.governor as Address,
  };
}

function readProposeParams(options: Record<string, unknown>): ProposeProposalParams {
  if (!options.targets || !options.values || !options.calldatas || !options.description) {
    throw new Error(
      "Missing required parameters for proposal (targets, values, calldatas, description)"
    );
  }
  const base = readBase(options);
  return {
    ...base,
    targets: options.targets as Address[],
    values: (options.values as string[]).map((v) => BigInt(v)),
    calldatas: options.calldatas as Hex[],
    description: String(options.description),
  };
}

function readVoteParams(options: Record<string, unknown>): VoteParams {
  if (
    options.proposalId === undefined ||
    options.support === undefined ||
    options.support === null
  ) {
    throw new Error("Missing required 'proposalId' or 'support' for vote");
  }
  const base = readBase(options);
  return {
    ...base,
    proposalId: String(options.proposalId),
    support: Number(options.support),
  };
}

function readQueueParams(options: Record<string, unknown>): QueueProposalParams {
  if (!options.targets || !options.values || !options.calldatas || !options.description) {
    throw new Error(
      "Missing required parameters for queue (targets, values, calldatas, description)"
    );
  }
  const base = readBase(options);
  return {
    ...base,
    targets: options.targets as Address[],
    values: (options.values as string[]).map((v) => BigInt(v)),
    calldatas: options.calldatas as Hex[],
    description: String(options.description),
  };
}

function readExecuteParams(options: Record<string, unknown>): ExecuteProposalParams {
  if (
    !options.proposalId ||
    !options.targets ||
    !options.values ||
    !options.calldatas ||
    !options.description
  ) {
    throw new Error(
      "Missing required parameters for execute (proposalId, targets, values, calldatas, description)"
    );
  }
  const base = readBase(options);
  return {
    ...base,
    proposalId: String(options.proposalId),
    targets: options.targets as Address[],
    values: (options.values as string[]).map((v) => BigInt(v)),
    calldatas: options.calldatas as Hex[],
    description: String(options.description),
  };
}

const spec = requireActionSpec("WALLET_GOV_OP");

export const govOpAction = {
  name: spec.name,
  description: spec.description,
  descriptionCompressed: spec.descriptionCompressed,
  contexts: ["finance", "crypto", "wallet", "admin"],
  contextGate: { anyOf: ["finance", "crypto", "wallet", "admin"] },
  roleGate: { minRole: "USER" },
  parameters: [
    {
      name: "op",
      description: "Governance operation to perform.",
      required: true,
      schema: { type: "string", enum: ["propose", "vote", "queue", "execute"] },
    },
    {
      name: "chain",
      description: "EVM chain identifier for the governance transaction.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "governor",
      description: "Governor contract address.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "proposalId",
      description: "Governance proposal id for vote, queue, or execute.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "support",
      description: "Vote support value for vote operations.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "targets",
      description: "Target contract addresses for proposal, queue, or execute.",
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
    {
      name: "values",
      description: "ETH values as strings for proposal, queue, or execute.",
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
    {
      name: "calldatas",
      description: "Hex calldata values for proposal, queue, or execute.",
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
    {
      name: "description",
      description: "Proposal description for proposal, queue, or execute.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "confirmed",
      description: "Whether the user confirmed submitting the governance transaction.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
    options: Record<string, unknown> | undefined,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const opts = options ?? {};
      const op = readGovOp(opts);

      let preview: string;
      let data: Hex;
      let parameters: object;

      switch (op) {
        case "propose": {
          const params = readProposeParams(opts);
          parameters = params;
          preview = `Review governance proposal before submitting: ${params.targets.length} target(s) on ${params.chain}, governor ${params.governor}. Re-invoke ${spec.name} with confirmed: true to submit.`;
          data = encodeProposeData(params);
          break;
        }
        case "vote": {
          const params = readVoteParams(opts);
          parameters = params;
          preview = `Review governance vote before submitting: proposal ${params.proposalId} on ${params.chain}, governor ${params.governor}, support ${params.support}. Re-invoke ${spec.name} with confirmed: true to submit.`;
          data = encodeVoteData(params);
          break;
        }
        case "queue": {
          const params = readQueueParams(opts);
          parameters = params;
          preview = `Review governance queue before submitting: ${params.targets.length} target(s) on ${params.chain}, governor ${params.governor}. Re-invoke ${spec.name} with confirmed: true to submit.`;
          data = encodeQueueData(params);
          break;
        }
        case "execute": {
          const params = readExecuteParams(opts);
          parameters = params;
          preview = `Review governance execution before submitting: proposal ${params.proposalId} with ${params.targets.length} target(s) on ${params.chain}, governor ${params.governor}. Re-invoke ${spec.name} with confirmed: true to submit.`;
          data = encodeExecuteData(params);
          break;
        }
      }

      if (!isConfirmed(opts)) {
        return confirmationRequired({
          actionName: spec.name,
          preview,
          parameters: { ...parameters, op },
          callback,
        });
      }

      const base = readBase(opts);
      const privateKey = runtime.getSetting("EVM_PRIVATE_KEY") as `0x${string}`;
      const walletProvider = new WalletProvider(privateKey, runtime);
      const result = await sendGovTx(walletProvider, base.chain, base.governor, data);

      const verb =
        op === "propose"
          ? "submitted"
          : op === "vote"
            ? "submitted"
            : op === "queue"
              ? "queued"
              : "executed";
      return {
        success: true,
        text: `Proposal ${verb} successfully. Transaction hash: ${result.hash}`,
        data: {
          op,
          transactionHash: result.hash,
          from: result.from,
          to: result.to,
          chain: base.chain,
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
  validate: createEvmActionValidator({
    keywords: [
      "propose",
      "proposal",
      "governance",
      "dao",
      "vote",
      "queue",
      "execute",
      "governor",
      "timelock",
    ],
    regex:
      /\b(?:propose|proposal|governance|dao|vote|abstain|queue|queued|timelock|execute|execution|governor)\b/i,
  }),
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Propose transferring 1e18 tokens on the governor at 0x1234... on Ethereum",
          action: "WALLET_GOV_OP",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Vote yes on proposal 123 on the governor at 0x1234... on Ethereum",
          action: "WALLET_GOV_OP",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Queue proposal 123 on the governor at 0x1234... on Ethereum",
          action: "WALLET_GOV_OP",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Execute proposal 123 on the governor at 0x1234... on Ethereum",
          action: "WALLET_GOV_OP",
        },
      },
    ],
  ],
  similes: spec.similes ? [...spec.similes] : [],
};
