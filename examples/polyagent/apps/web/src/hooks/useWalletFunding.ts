import { CHAIN, WALLET_ERROR_MESSAGES } from "@polyagent/shared";
import { useFundWallet } from "@privy-io/react-auth";
import { useCallback, useRef } from "react";
import { toast } from "sonner";
import { formatEther } from "viem";
import { useSmartWalletBalance } from "./useSmartWalletBalance";

/**
 * Options for the ensureFunds function.
 */
interface EnsureFundsOptions {
  /** AbortSignal for cancellation support */
  signal?: AbortSignal;
  /** Maximum polling attempts (default: 30) */
  maxAttempts?: number;
  /** Polling interval in milliseconds (default: 1000) */
  pollInterval?: number;
  /** Whether to show toast notifications (default: true) */
  showToasts?: boolean;
}

/**
 * Result type for the useWalletFunding hook.
 */
interface UseWalletFundingResult {
  /**
   * Ensures the wallet has sufficient funds for a transaction.
   * If insufficient, prompts user to fund the wallet and polls for balance updates.
   *
   * @param smartWalletAddress - The address of the smart wallet to fund
   * @param requiredAmountWei - The required amount in wei
   * @param options - Optional configuration for polling and cancellation
   * @returns Promise that resolves to true when funds are available
   * @throws Error if wallet address is missing, operation is cancelled, or funds don't arrive in time
   */
  ensureFunds: (
    smartWalletAddress: string | undefined,
    requiredAmountWei: bigint,
    options?: EnsureFundsOptions,
  ) => Promise<boolean>;
}

/**
 * Hook for managing wallet funding operations.
 *
 * Provides a reusable function to ensure a smart wallet has sufficient funds
 * for a transaction. If the wallet has insufficient balance, it prompts the
 * user to fund it and polls for the deposit to arrive.
 *
 * Features:
 * - Balance checking with auto-refresh
 * - Wallet funding via Privy's fundWallet
 * - Cancellable polling with AbortSignal support
 * - Toast notifications for user feedback
 * - Configurable polling parameters
 *
 * @returns Object containing the ensureFunds function
 *
 * @example
 * ```tsx
 * const { ensureFunds } = useWalletFunding();
 *
 * const handlePayment = async () => {
 *   const abortController = new AbortController();
 *
 *   try {
 *     await ensureFunds(walletAddress, requiredAmount, {
 *       signal: abortController.signal,
 *     });
 *     // Proceed with payment...
 *   } catch (error) {
 *     if (error.message === 'Operation cancelled') {
 *       // Handle cancellation
 *     }
 *   }
 * };
 * ```
 */
export function useWalletFunding(): UseWalletFundingResult {
  const { fundWallet } = useFundWallet();
  const { balance, refreshBalance } = useSmartWalletBalance();

  // Store toast ID in ref to dismiss on cancellation
  const toastIdRef = useRef<string | number | null>(null);

  const ensureFunds = useCallback(
    async (
      smartWalletAddress: string | undefined,
      requiredAmountWei: bigint,
      options?: EnsureFundsOptions,
    ): Promise<boolean> => {
      const {
        signal,
        maxAttempts = 30,
        pollInterval = 1000,
        showToasts = true,
      } = options ?? {};

      if (!smartWalletAddress) {
        throw new Error(WALLET_ERROR_MESSAGES.NO_EMBEDDED_WALLET);
      }

      // Check if operation was cancelled before starting
      if (signal?.aborted) {
        throw new Error("Operation cancelled");
      }

      // Check current balance
      const currentBalance = balance ?? (await refreshBalance());
      if (currentBalance !== null && currentBalance >= requiredAmountWei) {
        return true;
      }

      // Calculate deficit (we know balance is insufficient since we returned early above)
      const deficit = requiredAmountWei - (currentBalance ?? 0n);

      // Prompt user to fund wallet
      await fundWallet({
        address: smartWalletAddress,
        options: {
          chain: CHAIN,
          amount: formatEther(deficit),
          asset: "native-currency",
        },
      });

      // Show feedback to user
      if (showToasts) {
        toastIdRef.current = toast.info("Waiting for deposit to settle...");
      }

      // Poll for balance updates with cancellation support
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Check if operation was cancelled before each poll
        if (signal?.aborted) {
          if (toastIdRef.current && showToasts) {
            toast.dismiss(toastIdRef.current);
            toastIdRef.current = null;
          }
          throw new Error("Operation cancelled");
        }

        const updatedBalance = await refreshBalance();

        if (updatedBalance && updatedBalance >= requiredAmountWei) {
          if (showToasts) {
            toast.success("Funds received!");
          }
          return true;
        }

        // Wait before next check (except on last attempt)
        if (attempt < maxAttempts - 1) {
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, pollInterval);

            // Handle abort during wait - resolve immediately instead of hanging
            const abortHandler = () => {
              clearTimeout(timeout);
              resolve();
            };

            if (signal) {
              signal.addEventListener("abort", abortHandler, { once: true });
            }
          });
        }
      }

      // If we get here, funds didn't arrive in time
      if (showToasts) {
        toast.error("Deposit is taking longer than expected");
      }
      throw new Error(
        "Funds are still settling. Please try again in a moment once the deposit arrives.",
      );
    },
    [balance, fundWallet, refreshBalance],
  );

  return { ensureFunds };
}
