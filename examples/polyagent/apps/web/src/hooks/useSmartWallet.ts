import { logger, WALLET_ERROR_MESSAGES } from "@polyagent/shared";
import { useWallets } from "@privy-io/react-auth";
import type { SmartWalletClientType } from "@privy-io/react-auth/smart-wallets";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Hex } from "viem";

type SmartWalletTxInput = Parameters<
  SmartWalletClientType["sendTransaction"]
>[0];
type SmartWalletTxOptions = Parameters<
  SmartWalletClientType["sendTransaction"]
>[1];

/**
 * Return type for the useSmartWallet hook.
 */
interface UseSmartWalletResult {
  /** The Privy smart wallet client instance */
  client?: SmartWalletClientType;
  /** The smart wallet address (if available) */
  smartWalletAddress?: string;
  /** Whether the smart wallet is ready for transactions */
  smartWalletReady: boolean;
  /** Function to send a transaction via the smart wallet */
  sendSmartWalletTransaction: (
    input: SmartWalletTxInput,
    options?: SmartWalletTxOptions,
  ) => Promise<Hex>;
}

/**
 * Hook for managing smart wallet operations.
 *
 * Provides access to Privy's smart wallet functionality, enabling gasless
 * transactions when using an embedded wallet. The smart wallet is a contract
 * wallet that can be sponsored by Privy's paymaster, allowing users to
 * interact with the blockchain without holding native tokens.
 *
 * @returns Smart wallet state and transaction sending function.
 *
 * @example
 * ```tsx
 * const { smartWalletReady, sendSmartWalletTransaction } = useSmartWallet();
 *
 * const handleTransaction = async () => {
 *   if (!smartWalletReady) {
 *     throw new Error('Smart wallet not ready');
 *   }
 *
 *   const txHash = await sendSmartWalletTransaction({
 *     to: '0x...',
 *     value: parseEther('0.1'),
 *     data: '0x...'
 *   });
 * };
 * ```
 */
export function useSmartWallet(): UseSmartWalletResult {
  const { client } = useSmartWallets();
  const { wallets } = useWallets();
  const lastLoggedState = useRef<boolean | null>(null);
  const hasLoggedWarning = useRef(false);

  // Check if embedded wallet exists
  const hasEmbeddedWallet = useMemo(
    () => wallets.some((w) => w.walletClientType === "privy"),
    [wallets],
  );

  // Only log when the state changes, not on every render
  useEffect(() => {
    const hasClient = !!client;
    const hasAddress = !!client?.account?.address;

    if (lastLoggedState.current !== hasClient) {
      lastLoggedState.current = hasClient;
      logger.debug("Smart wallet client state changed", {
        hasClient,
        hasAddress,
        address: client?.account?.address,
        hasEmbeddedWallet,
      });
    }

    // Log a warning if client is not available after a delay (but only once)
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    if (!hasClient && !hasLoggedWarning.current) {
      timeoutId = setTimeout(() => {
        if (!client) {
          hasLoggedWarning.current = true;
          const message = hasEmbeddedWallet
            ? "Smart wallet client not initialized despite embedded wallet existing. This may indicate a Privy configuration issue."
            : "Smart wallet client not initialized. Embedded wallet may not be created yet.";
          logger.warn(message, { hasEmbeddedWallet }, "useSmartWallet");
        }
      }, 5000); // Wait 5 seconds before warning
    }

    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [client, hasEmbeddedWallet]);

  const typedClient = client as SmartWalletClientType | undefined;
  const smartWalletAddress = typedClient?.account?.address;
  const smartWalletReady = useMemo(
    () => Boolean(typedClient && smartWalletAddress),
    [typedClient, smartWalletAddress],
  );

  const sendSmartWalletTransaction = useCallback(
    async (
      input: SmartWalletTxInput,
      options?: SmartWalletTxOptions,
    ): Promise<Hex> => {
      if (!typedClient || !smartWalletAddress) {
        throw new Error(WALLET_ERROR_MESSAGES.NO_EMBEDDED_WALLET);
      }

      return await typedClient.sendTransaction(input, options);
    },
    [typedClient, smartWalletAddress],
  );

  return {
    client: typedClient,
    smartWalletAddress,
    smartWalletReady,
    sendSmartWalletTransaction,
  };
}
