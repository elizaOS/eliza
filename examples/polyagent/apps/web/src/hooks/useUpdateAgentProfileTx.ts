import {
  CAPABILITIES_HASH,
  CHAIN,
  getIdentityRegistryAddress,
  identityRegistryAbi,
  WALLET_ERROR_MESSAGES,
} from "@polyagent/shared";
import { useCallback } from "react";
import { encodeFunctionData } from "viem";
import { useSmartWallet } from "@/hooks/useSmartWallet";

/**
 * Metadata for updating an agent profile on-chain.
 */
export interface AgentProfileMetadata {
  /** Display name */
  name: string;
  /** Username (optional) */
  username?: string | null;
  /** Bio/description (optional) */
  bio?: string | null;
  /** Profile image URL (optional) */
  profileImageUrl?: string | null;
  /** Cover image URL (optional) */
  coverImageUrl?: string | null;
  /** Agent type (default: 'user') */
  type?: "user" | string;
  /** ISO timestamp of update */
  updated?: string;
}

/**
 * Input for updating an agent profile.
 */
interface UpdateAgentProfileInput {
  /** Profile metadata to update */
  metadata: AgentProfileMetadata;
  /** Optional custom endpoint URL (defaults to polyagent.market/agent/{address}) */
  endpoint?: string;
}

/**
 * Hook for updating an agent profile on-chain via the identity registry.
 *
 * Enables users to update their on-chain agent profile metadata including
 * name, username, bio, and image URLs. Updates are written to the blockchain
 * through the identity registry contract.
 *
 * Transactions are executed through the smart wallet, enabling gasless
 * transactions when using an embedded wallet.
 *
 * @returns An object containing:
 * - `updateAgentProfile`: Function to update the profile with new metadata
 * - `smartWalletAddress`: The smart wallet address (if available)
 * - `smartWalletReady`: Whether the smart wallet is ready for transactions
 *
 * @example
 * ```tsx
 * const { updateAgentProfile, smartWalletReady } = useUpdateAgentProfileTx();
 *
 * const handleUpdate = async () => {
 *   const txHash = await updateAgentProfile({
 *     metadata: {
 *       name: 'Updated Name',
 *       bio: 'New bio',
 *       profileImageUrl: 'https://...'
 *     }
 *   });
 *   console.log('Updated:', txHash);
 * };
 * ```
 */
export function useUpdateAgentProfileTx() {
  const { sendSmartWalletTransaction, smartWalletAddress, smartWalletReady } =
    useSmartWallet();
  const registryAddress = getIdentityRegistryAddress();

  const updateAgentProfile = useCallback(
    async ({ metadata, endpoint }: UpdateAgentProfileInput) => {
      if (!registryAddress) {
        throw new Error("Identity registry not configured for this chain");
      }

      if (!smartWalletReady || !smartWalletAddress) {
        throw new Error(WALLET_ERROR_MESSAGES.NO_EMBEDDED_WALLET);
      }

      const targetEndpoint =
        endpoint ??
        `https://polyagent.market/agent/${smartWalletAddress.toLowerCase()}`;

      const metadataJson = JSON.stringify({
        ...metadata,
        type: metadata.type ?? "user",
        updated: metadata.updated ?? new Date().toISOString(),
      });

      const data = encodeFunctionData({
        abi: identityRegistryAbi,
        functionName: "updateAgent",
        args: [targetEndpoint, CAPABILITIES_HASH, metadataJson],
      });

      return await sendSmartWalletTransaction({
        to: registryAddress,
        data,
        value: 0n,
        chain: CHAIN,
      });
    },
    [
      registryAddress,
      sendSmartWalletTransaction,
      smartWalletAddress,
      smartWalletReady,
    ],
  );

  return {
    updateAgentProfile,
    smartWalletAddress,
    smartWalletReady,
  };
}
