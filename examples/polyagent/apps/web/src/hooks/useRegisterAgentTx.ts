import type { OnboardingProfilePayload } from "@polyagent/shared";
import {
  CAPABILITIES_HASH,
  CHAIN,
  getIdentityRegistryAddress,
  identityRegistryAbi,
  WALLET_ERROR_MESSAGES,
} from "@polyagent/shared";
import { useCallback } from "react";
import {
  type Address,
  createPublicClient,
  encodeFunctionData,
  http,
} from "viem";
import { useSmartWallet } from "@/hooks/useSmartWallet";

/**
 * Hook for registering an agent on-chain via the identity registry.
 *
 * Enables users to register their agent identity on the blockchain, creating
 * an on-chain record with their username, endpoint, capabilities, and metadata.
 * Checks if the wallet is already registered before attempting registration.
 *
 * Transactions are executed through the smart wallet, enabling gasless
 * transactions when using an embedded wallet.
 *
 * @returns An object containing:
 * - `registerAgent`: Function to register the agent with profile data
 * - `smartWalletAddress`: The smart wallet address (if available)
 * - `smartWalletReady`: Whether the smart wallet is ready for transactions
 *
 * @example
 * ```tsx
 * const { registerAgent, smartWalletReady } = useRegisterAgentTx();
 *
 * const handleRegister = async () => {
 *   if (!smartWalletReady) {
 *     alert('Wallet not ready');
 *     return;
 *   }
 *
 *   const txHash = await registerAgent({
 *     username: 'myagent',
 *     displayName: 'My Agent',
 *     bio: 'A helpful agent'
 *   });
 *   console.log('Registered:', txHash);
 * };
 * ```
 */
export function useRegisterAgentTx() {
  const { smartWalletAddress, smartWalletReady, sendSmartWalletTransaction } =
    useSmartWallet();
  const registryAddress = getIdentityRegistryAddress();

  const registerAgent = useCallback(
    async (profile: OnboardingProfilePayload) => {
      if (!registryAddress) {
        throw new Error("Identity registry not configured for this chain");
      }

      if (!smartWalletReady || !smartWalletAddress) {
        throw new Error(WALLET_ERROR_MESSAGES.NO_EMBEDDED_WALLET);
      }

      if (!profile.username) {
        throw new Error("Username is required to complete registration.");
      }

      const publicClient = createPublicClient({
        chain: CHAIN,
        transport: http(),
      });

      const isRegistered = await publicClient.readContract({
        address: registryAddress,
        abi: identityRegistryAbi,
        functionName: "isRegistered",
        args: [smartWalletAddress as Address],
      });

      if (isRegistered) {
        throw new Error(
          "Already registered - wallet is already registered on-chain",
        );
      }

      const agentEndpoint = `https://polyagent.market/agent/${smartWalletAddress.toLowerCase()}`;
      const metadataUri = JSON.stringify({
        name: profile.displayName ?? profile.username,
        username: profile.username,
        bio: profile.bio ?? "",
        type: "user",
        registered: new Date().toISOString(),
      });

      const data = encodeFunctionData({
        abi: identityRegistryAbi,
        functionName: "registerAgent",
        args: [profile.username, agentEndpoint, CAPABILITIES_HASH, metadataUri],
      });

      return await sendSmartWalletTransaction({
        to: registryAddress,
        data,
        value: 0n,
        chain: CHAIN,
      });
    },
    [
      smartWalletAddress,
      smartWalletReady,
      sendSmartWalletTransaction,
      registryAddress,
    ],
  );

  return { registerAgent, smartWalletAddress, smartWalletReady };
}
