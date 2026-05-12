import {
  type Address,
  encodeAbiParameters,
  type Hex,
  parseAbiParameters,
} from "viem";
import type { VerifierType } from "./types.js";

/**
 * Known verifier contract addresses on Base mainnet.
 * These are deployed once and shared by all StakeVault instances.
 */
export const VERIFIER_ADDRESSES: Record<
  string,
  Record<VerifierType, Address>
> = {
  // Base mainnet (chain ID 8453)
  "8453": {
    optimistic: "0x0000000000000000000000000000000000000000", // Pre-deployment: set after deploying StakeVault verifier contracts to Base
    hash: "0x0000000000000000000000000000000000000000", // Pre-deployment: set after deploying StakeVault verifier contracts to Base
  },
  // Base Sepolia testnet (chain ID 84532)
  "84532": {
    optimistic: "0x0000000000000000000000000000000000000000", // Pre-deployment: set after deploying StakeVault verifier contracts to Base
    hash: "0x0000000000000000000000000000000000000000", // Pre-deployment: set after deploying StakeVault verifier contracts to Base
  },
};

/**
 * Resolve a verifier type to its deployed contract address for a given chain
 * @param verifier - Built-in verifier type or custom contract address
 * @param chainId - Chain ID to look up
 * @returns The verifier contract address
 */
export function resolveVerifierAddress(
  verifier: VerifierType | Address,
  chainId: number,
): Address {
  if (verifier.startsWith("0x") && verifier.length === 42) {
    return verifier as Address;
  }

  const chainAddresses = VERIFIER_ADDRESSES[chainId.toString()];
  if (!chainAddresses) {
    throw new Error(`No verifier addresses configured for chain ${chainId}`);
  }

  const address = chainAddresses[verifier as VerifierType];
  if (!address || address === "0x0000000000000000000000000000000000000000") {
    throw new Error(
      `Verifier "${verifier}" not deployed on chain ${chainId}. Deploy it first or pass a custom address.`,
    );
  }

  return address;
}

/**
 * Encode verifier configuration data for the HashVerifier
 * @param expectedHash - SHA256 hash of the expected output
 * @returns ABI-encoded bytes for the verifierData field
 */
export function encodeHashVerifierData(expectedHash: Hex): Hex {
  return encodeAbiParameters(parseAbiParameters("bytes32"), [expectedHash]);
}

/**
 * Encode verifier configuration data for the OptimisticVerifier
 * @returns Empty bytes (optimistic verifier has no config)
 */
export function encodeOptimisticVerifierData(): Hex {
  return "0x";
}
