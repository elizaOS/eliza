/**
 * Validates public payout addresses and serializes the hidden profile-README
 * marker consumed by the contributor rewards pipeline.
 */

import bs58 from "bs58";

export interface WalletAddresses {
  ethereum?: string;
  solana?: string;
}

export const WALLET_LINKING_BEGIN = "<!-- WALLET-LINKING-BEGIN";
export const WALLET_LINKING_END = "WALLET-LINKING-END -->";

export function isValidEthereumAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

export function isValidSolanaAddress(value: string): boolean {
  const normalized = value.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(normalized)) return false;
  try {
    return bs58.decode(normalized).byteLength === 32;
  } catch {
    // error-policy:J3 Invalid base58 is an explicit validation failure.
    return false;
  }
}

export function generateWalletReadmeComment(
  addresses: WalletAddresses,
  now: Date = new Date(),
): string {
  const wallets = [
    addresses.ethereum
      ? { chain: "ethereum", address: addresses.ethereum.trim() }
      : null,
    addresses.solana
      ? { chain: "solana", address: addresses.solana.trim() }
      : null,
  ].filter((wallet): wallet is { chain: string; address: string } => !!wallet);

  if (wallets.length === 0) {
    throw new Error("Add at least one public wallet address.");
  }

  return `${WALLET_LINKING_BEGIN}
${JSON.stringify({ lastUpdated: now.toISOString(), wallets }, null, 2)}
${WALLET_LINKING_END}`;
}
