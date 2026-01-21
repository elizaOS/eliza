import { CHAIN, RPC_URL } from "@polyagent/shared";
import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { createPublicClient, http } from "viem";
import { useSmartWallet } from "@/hooks/useSmartWallet";

const publicClient = createPublicClient({
  chain: CHAIN,
  transport: http(RPC_URL),
});

/**
 * Hook for fetching and managing smart wallet balance.
 *
 * Automatically fetches the native token balance (ETH) for the connected
 * smart wallet. Updates when the smart wallet address changes. Provides
 * manual refresh capability.
 *
 * @returns An object containing:
 * - `balance`: Current balance in wei (bigint), or null if not available
 * - `loading`: Whether balance is currently being fetched
 * - `refreshBalance`: Function to manually refresh the balance
 *
 * @example
 * ```tsx
 * const { balance, loading, refreshBalance } = useSmartWalletBalance();
 *
 * if (loading) return <div>Loading balance...</div>;
 * if (balance) {
 *   return <div>Balance: {formatEther(balance)} ETH</div>;
 * }
 * ```
 */
export function useSmartWalletBalance() {
  const { smartWalletAddress } = useSmartWallet();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);

  const refreshBalance = useCallback(async () => {
    if (!smartWalletAddress) {
      setBalance(null);
      return null;
    }

    setLoading(true);
    const next = await publicClient.getBalance({
      address: smartWalletAddress as Address,
    });
    setBalance(next);
    setLoading(false);
    return next;
  }, [smartWalletAddress]);

  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  return {
    balance,
    loading,
    refreshBalance,
  };
}
