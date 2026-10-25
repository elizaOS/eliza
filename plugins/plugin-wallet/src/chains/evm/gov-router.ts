/**
 * On-chain governance (OpenZeppelin `Governor`) support for the `WALLET`/`gov`
 * subaction: validates op-specific required params, ABI-encodes the
 * propose/vote/queue/execute calldata against the `OZGovernor` artifact, and
 * `routeEvmGovernance` either returns a `prepare` quote or submits the
 * transaction through the wallet's signer.
 */
import type { Chain, Hex } from "viem";
import {
  type Address,
  encodeFunctionData,
  keccak256,
  stringToHex,
} from "viem";
import governorArtifacts from "./contracts/artifacts/OZGovernor.json" with {
  type: "json",
};
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
    // Whole bytes only: viem right-pads an odd digit count instead of
    // refusing it, so the signed calldata would differ from the confirmed text.
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
      throw new Error(`${key} must contain only hex calldata values.`);
    }
    return value as Hex;
  });
}

function asBigInt(value: string, key: string): bigint {
  try {
    return BigInt(value);
  } catch {
    // BigInt's own SyntaxError text is engine-specific and does not name the
    // field; this message reaches the user as the INVALID_PARAMS detail.
    throw new Error(`${key} must be a base-10 integer string.`);
  }
}

/**
 * The parallel `targets` / `values` (wei) / `calldatas` arrays of a Governor
 * call. The Governor reverts when their lengths differ, so that is rejected
 * here, before anything is confirmed or signed.
 */
function proposalCalls(
  params: WalletRouterParams,
): [Address[], bigint[], Hex[]] {
  const targets = asAddressArray(requireArray(params, "targets"), "targets");
  const values = requireArray(params, "values").map((value) =>
    asBigInt(value, "values"),
  );
  const calldatas = asHexArray(requireArray(params, "calldatas"), "calldatas");
  if (targets.length !== values.length || targets.length !== calldatas.length) {
    throw new Error(
      `targets, values and calldatas must have the same length for governance ${params.op}.`,
    );
  }
  return [targets, values, calldatas];
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
    // Run the signer path's presence checks, parsing and ABI encoding now, so
    // a missing or malformed governor, proposalId, target, value or calldata
    // is refused before the user is asked to confirm instead of after.
    encodeWalletGovData(params);
    if (params.op === "vote" && params.support === undefined) {
      return "support is required for governance vote.";
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
          ...proposalCalls(params),
          requireDescription(params),
        ],
      }) as Hex;
    case "vote":
      return encodeFunctionData({
        abi: governorArtifacts.abi,
        functionName: "castVote",
        args: [
          asBigInt(requireProposalId(params), "proposalId"),
          BigInt(params.support ?? 0),
        ],
      }) as Hex;
    case "queue": {
      const description = requireDescription(params);
      return encodeFunctionData({
        abi: governorArtifacts.abi,
        functionName: "queue",
        args: [
          ...proposalCalls(params),
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
          ...proposalCalls(params),
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
