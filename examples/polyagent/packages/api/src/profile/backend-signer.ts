/**
 * Backend Profile Signer
 *
 * Allows the server to sign profile updates on behalf of users,
 * eliminating the need for signature popups in the UI.
 *
 * This enables a seamless UX where profile updates (including username changes)
 * happen instantly without user interaction, while still being recorded on-chain.
 */

import {
  CAPABILITIES_HASH,
  getIdentityRegistryAddress,
  identityRegistryAbi,
  logger,
} from "@polyagent/shared";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const PROFILE_MANAGER_PRIVATE_KEY = process.env.PROFILE_MANAGER_PRIVATE_KEY;
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

export interface ProfileMetadata {
  name: string;
  username: string | null;
  bio: string | null;
  profileImageUrl: string | null;
  coverImageUrl: string | null;
  type?: string;
  updated?: string;
}

export interface BackendSignedUpdateParams {
  userAddress: Address;
  metadata: ProfileMetadata;
  endpoint: string;
}

export interface BackendSignedUpdateResult {
  txHash: `0x${string}`;
  metadata: ProfileMetadata;
}

/**
 * Check if backend signing is configured
 */
export function isBackendSigningEnabled(): boolean {
  return Boolean(PROFILE_MANAGER_PRIVATE_KEY);
}

/**
 * Update user profile by signing the transaction server-side
 *
 * This eliminates the need for users to sign transactions for profile updates.
 * The server signs on behalf of the user, providing a seamless UX.
 *
 * @param params - Profile update parameters
 * @returns Transaction hash and metadata
 */
export async function updateProfileBackendSigned({
  userAddress,
  metadata,
  endpoint,
}: BackendSignedUpdateParams): Promise<BackendSignedUpdateResult> {
  if (!PROFILE_MANAGER_PRIVATE_KEY) {
    throw new Error(
      "Backend signing not configured. Set PROFILE_MANAGER_PRIVATE_KEY environment variable.",
    );
  }

  logger.info(
    "Backend signing profile update",
    { userAddress, username: metadata.username },
    "BackendSigner",
  );

  // Create wallet client with server's private key
  const account = privateKeyToAccount(
    PROFILE_MANAGER_PRIVATE_KEY as `0x${string}`,
  );
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  const registryAddress = getIdentityRegistryAddress();
  if (!registryAddress) {
    throw new Error("Identity registry not configured for this chain");
  }

  // Prepare metadata JSON
  const metadataJson = JSON.stringify({
    ...metadata,
    type: metadata.type || "user",
    updated: metadata.updated || new Date().toISOString(),
  });

  logger.debug(
    "Submitting on-chain update",
    {
      registry: registryAddress,
      endpoint,
      signer: account.address,
    },
    "BackendSigner",
  );

  // Sign and submit transaction
  const txHash = await walletClient.writeContract({
    address: registryAddress,
    abi: identityRegistryAbi,
    functionName: "updateAgent",
    args: [endpoint, CAPABILITIES_HASH, metadataJson],
  });

  logger.info(
    "Profile update transaction submitted",
    { txHash, userAddress },
    "BackendSigner",
  );

  // Wait for transaction confirmation
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
  });

  if (receipt.status !== "success") {
    throw new Error("Transaction failed on-chain");
  }

  logger.info(
    "Profile update confirmed on-chain",
    { txHash, blockNumber: receipt.blockNumber.toString() },
    "BackendSigner",
  );

  return {
    txHash,
    metadata,
  };
}

/**
 * Verify a backend-signed transaction was successful
 *
 * @param txHash - Transaction hash to verify
 * @returns Whether the transaction succeeded
 */
export async function verifyBackendSignedUpdate(
  txHash: `0x${string}`,
): Promise<boolean> {
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  return receipt.status === "success";
}
