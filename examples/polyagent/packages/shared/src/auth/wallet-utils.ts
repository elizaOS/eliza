/**
 * Wallet Utility Functions
 *
 * @description Utility functions for detecting and validating Privy embedded wallets
 * vs external wallets. Provides error message helpers for wallet-related operations.
 */

import type { ConnectedWallet } from "@privy-io/react-auth";

/**
 * Check if a wallet is a Privy embedded wallet
 *
 * @description Determines if a connected wallet is a Privy-managed embedded wallet
 * (smart wallet) as opposed to an external wallet like MetaMask or Coinbase Wallet.
 *
 * @param {ConnectedWallet | null | undefined} wallet - The wallet to check
 * @returns {boolean} True if the wallet is a Privy embedded wallet
 *
 * @example
 * ```typescript
 * const isEmbedded = isEmbeddedPrivyWallet(connectedWallet);
 * if (isEmbedded) {
 *   // Use smart wallet features
 * }
 * ```
 */
export function isEmbeddedPrivyWallet(
  wallet?: ConnectedWallet | null,
): boolean {
  if (!wallet) return false;
  return (
    wallet.walletClientType === "privy" ||
    wallet.walletClientType === "privy-v2"
  );
}

/**
 * Check if a wallet is an external wallet (not Privy embedded)
 *
 * @description Determines if a connected wallet is an external wallet (e.g., MetaMask,
 * Coinbase Wallet) rather than a Privy embedded smart wallet.
 *
 * @param {ConnectedWallet | null | undefined} wallet - The wallet to check
 * @returns {boolean} True if the wallet is an external wallet
 *
 * @example
 * ```typescript
 * const isExternal = isExternalWallet(connectedWallet);
 * if (isExternal) {
 *   // Handle external wallet differently
 * }
 * ```
 */
export function isExternalWallet(wallet?: ConnectedWallet | null): boolean {
  if (!wallet) return false;
  return !isEmbeddedPrivyWallet(wallet);
}

/**
 * Find the embedded wallet from a list of wallets
 *
 * @description Searches through an array of connected wallets and returns the first
 * Privy embedded wallet found, if any.
 *
 * @param {ConnectedWallet[]} wallets - Array of connected wallets to search
 * @returns {ConnectedWallet | undefined} The embedded wallet, or undefined if not found
 *
 * @example
 * ```typescript
 * const embeddedWallet = findEmbeddedWallet(allWallets);
 * if (embeddedWallet) {
 *   // Use embedded wallet for transactions
 * }
 * ```
 */
export function findEmbeddedWallet(
  wallets: ConnectedWallet[],
): ConnectedWallet | undefined {
  return wallets.find(isEmbeddedPrivyWallet);
}

/**
 * Find an external wallet from a list of wallets
 *
 * @description Searches through an array of connected wallets and returns the first
 * external wallet found (not Privy embedded), if any.
 *
 * @param {ConnectedWallet[]} wallets - Array of connected wallets to search
 * @returns {ConnectedWallet | undefined} The external wallet, or undefined if not found
 *
 * @example
 * ```typescript
 * const externalWallet = findExternalWallet(allWallets);
 * if (externalWallet) {
 *   // Handle external wallet
 * }
 * ```
 */
export function findExternalWallet(
  wallets: ConnectedWallet[],
): ConnectedWallet | undefined {
  return wallets.find(isExternalWallet);
}

/**
 * Error messages for wallet-related issues
 *
 * @description Predefined user-friendly error messages for common wallet-related
 * errors. Used to provide consistent error messaging across the application.
 */
export const WALLET_ERROR_MESSAGES = {
  NO_EMBEDDED_WALLET:
    "Your Polyagent smart wallet is required for this action. Please wait for it to finish preparing.",
  EXTERNAL_WALLET_ONLY:
    "You are connected with an external wallet. Please switch to your Polyagent smart wallet to continue.",
  NO_WALLET: "Please connect a wallet to continue.",
  SPONSOR_FAILED:
    "Unable to sponsor this transaction. Make sure your Polyagent smart wallet is active.",
  USER_REJECTED: "Transaction was cancelled in your wallet.",
  INSUFFICIENT_FUNDS:
    "Insufficient funds to cover gas. Use your Polyagent smart wallet for sponsored transactions.",
} as const;

/**
 * Get a user-friendly error message for wallet-related errors
 *
 * @description Analyzes an error and returns a user-friendly message based on
 * common wallet error patterns. Maps technical errors to readable messages.
 *
 * @param {unknown} error - The error to analyze
 * @returns {string} User-friendly error message
 *
 * @example
 * ```typescript
 * try {
 *   await sendTransaction();
 * } catch (error) {
 *   const message = getWalletErrorMessage(error);
 *   showToast(message);
 * }
 * ```
 */
export function getWalletErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error);

  if (message.includes("user rejected") || message.includes("user denied")) {
    return WALLET_ERROR_MESSAGES.USER_REJECTED;
  }

  if (message.includes("insufficient funds")) {
    return WALLET_ERROR_MESSAGES.INSUFFICIENT_FUNDS;
  }

  if (message.includes("sponsor")) {
    return WALLET_ERROR_MESSAGES.SPONSOR_FAILED;
  }

  if (message.includes("no wallet") || message.includes("wallet not found")) {
    return WALLET_ERROR_MESSAGES.NO_WALLET;
  }

  return error instanceof Error
    ? error.message
    : "An unknown error occurred with your wallet.";
}
