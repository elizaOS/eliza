import type { Chain, Hex } from "viem";
import {
  type Address,
  encodeFunctionData,
  keccak256,
  stringToHex,
} from "viem";
import governorArtifacts from "./contracts/artifacts/OZGovernor.json";
import { buildSendTxParams } from "./actions/helpers";
import { initWalletProvider, type WalletProvider } from "./providers/wallet";
import type {
  WalletRouterContext,
  WalletRouterExecution,
  WalletRouterParams,
} from "../../types/wallet-router.js";
import type { SupportedChain } from "./types";

function isEvmAddress(value: string | undefined): value is Address {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function requireGovernor(params: WalletRouterParams): Address {
  if (!isEvmAddress(params.governor)) {
    throw new Error("governor must be a valid EVM address.");
  }
  return params.governor;
}

function requireArray(
  params: WalletRouterParams,
  key: "targets" | "values" | "calldatas",
): readonly string[] {
  const value = params[key];
  if (!value || value.length === 0) {
    throw new Error(`${key} is required for governance ${params.op}.`);
  }
  return value;
}

function requireDescription(params: WalletRouterParams): string {
  if (!params.description) {
    throw new Error(`description is required for governance ${params.op}.`);
  }
  return params.description;
}

function requireProposalId(params: WalletRouterParams): string {
  if (!params.proposalId) {
    throw new Error(`proposalId is required for governance ${params.op}.`);
  }
  return params.proposalId;
}

function asAddressArray(values: readonly string[], key: string): Address[] {
  return values.map((value) => {
    if (!isEvmAddress(value)) {
      throw new Error(`${key} must contain only valid EVM addresses.`);
    }
    return value;
  });
}

function asHexArray(values: readonly string[], key: string): Hex[] {
  return values.map((value) => {
    if (!/^0x[0-9a-fA-F]*$/.test(value)) {
      throw new Error(`${key} must contain only hex calldata values.`);
    }
    return value as Hex;
  });
}

function asBigIntArray(values: readonly string[]): bigint[] {
  return values.map((value) => BigInt(value));
}

function descriptionHash(description: string): Hex {
  return keccak256(stringToHex(description));
}

export function validateWalletGovParams(
  params: WalletRouterParams,
): string | null {
  try {
    if (!params.op) {
      return "op is required for governance actions.";
    }
    requireGovernor(params);
    switch (params.op) {
      case "propose":
        requireArray(params, "targets");
        requireArray(params, "values");
        requireArray(params, "calldatas");
        requireDescription(params);
        break;
      case "vote":
        requireProposalId(params);
        if (params.support === undefined) {
          return "support is required for governance vote.";
        }
        break;
      case "queue":
        requireArray(params, "targets");
        requireArray(params, "values");
        requireArray(params, "calldatas");
        requireDescription(params);
        break;
      case "execute":
        requireProposalId(params);
        requireArray(params, "targets");
        requireArray(params, "values");
        requireArray(params, "calldatas");
        requireDescription(params);
        break;
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function encodeWalletGovData(params: WalletRouterParams): Hex {
  const governor = requireGovernor(params);
  void governor;

  switch (params.op) {
    case "propose":
      return encodeFunctionData({
        abi: governorArtifacts.abi,
        functionName: "propose",
        args: [
          asAddressArray(requireArray(params, "targets"), "targets"),
          asBigIntArray(requireArray(params, "values")),
          asHexArray(requireArray(params, "calldatas"), "calldatas"),
          requireDescription(params),
        ],
      }) as Hex;
    case "vote":
      return encodeFunctionData({
        abi: governorArtifacts.abi,
        functionName: "castVote",
        args: [BigInt(requireProposalId(params)), BigInt(params.support ?? 0)],
      }) as Hex;
    case "queue": {
      const description = requireDescription(params);
      return encodeFunctionData({
        abi: governorArtifacts.abi,
        functionName: "queue",
        args: [
          asAddressArray(requireArray(params, "targets"), "targets"),
          asBigIntArray(requireArray(params, "values")),
          asHexArray(requireArray(params, "calldatas"), "calldatas"),
          descriptionHash(description),
        ],
      }) as Hex;
    }
    case "execute": {
      requireProposalId(params);
      const description = requireDescription(params);
      return encodeFunctionData({
        abi: governorArtifacts.abi,
        functionName: "execute",
        args: [
          asAddressArray(requireArray(params, "targets"), "targets"),
          asBigIntArray(requireArray(params, "values")),
          asHexArray(requireArray(params, "calldatas"), "calldatas"),
          descriptionHash(description),
        ],
      }) as Hex;
    }
    default:
      throw new Error(
        "Missing or invalid op (expected propose | vote | queue | execute).",
      );
  }
}

export async function routeEvmGovernance(
  params: WalletRouterParams,
  context: WalletRouterContext,
  chainKey: string,
  chain: Chain,
  walletProvider?: WalletProvider,
): Promise<WalletRouterExecution> {
  const governor = requireGovernor(params);
  const data = encodeWalletGovData(params);

  if (params.mode === "prepare" || params.dryRun) {
    return {
      status: "prepared",
      chain: chainKey,
      chainId: String(chain.id),
      subaction: "gov",
      dryRun: params.dryRun,
      mode: params.mode,
      to: governor,
      metadata: {
        op: params.op,
        governor,
        proposalId: params.proposalId,
        support: params.support,
        targets: params.targets,
        values: params.values,
        calldatas: params.calldatas,
        description: params.description,
        transactionRequest: {
          to: governor,
          value: "0",
          data,
          chainId: chain.id,
        },
        requiresConfirmation: true,
      },
    };
  }

  const provider = walletProvider ?? (await initWalletProvider(context.runtime));
  const walletClient = provider.getWalletClient(chainKey as SupportedChain);
  const account = walletClient.account;
  if (!account) {
    throw new Error("Wallet account is not available.");
  }

  const hash = await walletClient.sendTransaction(
    buildSendTxParams({
      account,
      to: governor,
      value: 0n,
      data,
      chain,
    }),
  );

  return {
    status: "submitted",
    chain: chainKey,
    chainId: String(chain.id),
    subaction: "gov",
    dryRun: false,
    mode: params.mode,
    transactionHash: hash,
    from: account.address,
    to: governor,
    metadata: {
      op: params.op,
      proposalId: params.proposalId,
      support: params.support,
      data,
    },
  };
}
