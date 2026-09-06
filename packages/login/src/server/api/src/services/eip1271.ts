/**
 * EIP-1271 verification helper.
 *
 * Smart contract wallets (Safe, Argent, etc.) cannot use ECDSA recover. They
 * implement `isValidSignature(bytes32 hash, bytes signature) returns (bytes4)`
 * and the magic value `0x1626ba7e` indicates a valid signature.
 *
 * Reference: https://eips.ethereum.org/EIPS/eip-1271
 *
 * We do this manually with viem rather than passing an ethers provider into
 * siwe (siwe@3 still depends on ethers). This way we avoid pulling in ethers
 * just for EIP-1271 verification.
 */

import {
  type Address,
  createPublicClient,
  type Hex,
  hashMessage,
  http,
  isAddress,
  type PublicClient,
} from "viem";

const EIP1271_MAGIC_VALUE = "0x1626ba7e" as const;

const ISVALID_SIGNATURE_ABI = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes4" }],
  },
] as const;

export interface ChainRpcConfig {
  /** Chain ID (e.g. 1 for mainnet, 8453 for Base, 56 for BSC). */
  chainId: number;
  /** JSON-RPC URL. */
  rpcUrl: string;
}

const DEFAULT_PUBLIC_RPCS: Record<number, string> = {
  1: "https://ethereum-rpc.publicnode.com",
  10: "https://optimism-rpc.publicnode.com",
  56: "https://bsc-rpc.publicnode.com",
  137: "https://polygon-bor-rpc.publicnode.com",
  8453: "https://base-rpc.publicnode.com",
  42161: "https://arbitrum-one-rpc.publicnode.com",
  // testnets
  11155111: "https://ethereum-sepolia-rpc.publicnode.com",
  84532: "https://base-sepolia-rpc.publicnode.com",
};

/**
 * Resolve an RPC URL for a given chain ID.
 *
 * Override priority:
 * 1. `SIWE_RPC_<CHAIN_ID>` env var (for production: private RPC URLs)
 * 2. `DEFAULT_PUBLIC_RPCS` fallback for major chains — non-production only
 *
 * SEC-140: the hardcoded public RPCs are a single point of compromise for the
 * EIP-1271 `isValidSignature` decision — a compromised or MITM'd public RPC
 * can forge the magic value and log in as any contract wallet on that chain.
 * Production therefore fails closed (null → "no_rpc") unless the operator
 * configures `SIWE_RPC_<CHAIN_ID>`; the public fallback remains for
 * development convenience.
 *
 * Returns null if no RPC is available for this chain.
 */
export function resolveRpcUrl(chainId: number): string | null {
  const envOverride = process.env[`SIWE_RPC_${chainId}`];
  if (envOverride && envOverride.trim().length > 0) {
    return envOverride.trim();
  }
  if (process.env.NODE_ENV === "production") return null;
  return DEFAULT_PUBLIC_RPCS[chainId] ?? null;
}

/**
 * Build a viem PublicClient for the given chain. Returns null if no RPC is
 * configured for the chain.
 *
 * Exposed so tests can mock the factory.
 */
export type PublicClientFactory = (chainId: number) => PublicClient | null;

export const defaultPublicClientFactory: PublicClientFactory = (
  chainId: number,
) => {
  const rpcUrl = resolveRpcUrl(chainId);
  if (!rpcUrl) return null;
  return createPublicClient({
    transport: http(rpcUrl),
    batch: { multicall: false },
  });
};

export interface VerifyEip1271Args {
  /** Smart contract wallet address (the signer). */
  address: Address;
  /** Original SIWE message text (will be hashed with EIP-191 personal_sign prefix). */
  message: string;
  /** Signature bytes (any length; smart contracts decide what's valid). */
  signature: Hex;
  /** Chain ID where the smart contract wallet is deployed. */
  chainId: number;
  /** Optional override of the public client factory (for tests). */
  clientFactory?: PublicClientFactory;
}

export interface VerifyEip1271Result {
  ok: boolean;
  /** Reason when ok=false. */
  reason?: "no_rpc" | "contract_call_failed" | "signature_invalid";
  /** Wrapped error if a thrown exception caused a contract_call_failed. */
  error?: unknown;
}

/**
 * Verify a signature against a smart contract wallet's `isValidSignature` method.
 *
 * Returns:
 *   { ok: true } if the contract returns the EIP-1271 magic value
 *   { ok: false, reason: "no_rpc" } if no RPC is configured for the chain
 *   { ok: false, reason: "contract_call_failed" } if the RPC call threw
 *     (contract not deployed, address is an EOA, etc.)
 *   { ok: false, reason: "signature_invalid" } if the contract returned a
 *     non-magic value
 */
export async function verifyEip1271(
  args: VerifyEip1271Args,
): Promise<VerifyEip1271Result> {
  if (!isAddress(args.address)) {
    return { ok: false, reason: "signature_invalid" };
  }

  const factory = args.clientFactory ?? defaultPublicClientFactory;
  const client = factory(args.chainId);
  if (!client) {
    return { ok: false, reason: "no_rpc" };
  }

  const messageHash = hashMessage(args.message);

  let result: Hex;
  try {
    // viem's `readContract` returns the decoded value typed by ABI. For
    // bytes4 it returns a hex string.
    result = (await client.readContract({
      address: args.address,
      abi: ISVALID_SIGNATURE_ABI,
      functionName: "isValidSignature",
      args: [messageHash, args.signature],
    })) as Hex;
  } catch (error) {
    // Common causes:
    //   - The address is an EOA (no `isValidSignature` method to call)
    //   - The contract is not deployed on this chain
    //   - The contract reverts
    return { ok: false, reason: "contract_call_failed", error };
  }

  if (result.toLowerCase() === EIP1271_MAGIC_VALUE.toLowerCase()) {
    return { ok: true };
  }
  return { ok: false, reason: "signature_invalid" };
}
