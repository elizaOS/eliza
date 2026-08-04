/**
 * Validates public payout addresses and serializes the hidden profile-README
 * marker consumed by the contributor rewards pipeline.
 */

import bs58 from "bs58";
import { isAddress } from "viem";

export interface WalletAddresses {
  ethereum?: string;
  solana?: string;
}

export const WALLET_LINKING_BEGIN = "<!-- WALLET-LINKING-BEGIN";
export const WALLET_LINKING_END = "WALLET-LINKING-END -->";

export class WalletAddressValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletAddressValidationError";
  }
}

export function isValidEthereumAddress(value: string): boolean {
  return isAddress(value.trim(), { strict: true });
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
  const ethereum = addresses.ethereum?.trim();
  const solana = addresses.solana?.trim();

  if (!ethereum && !solana) {
    throw new WalletAddressValidationError(
      "Add at least one public wallet address.",
    );
  }
  if (ethereum && !isValidEthereumAddress(ethereum)) {
    throw new WalletAddressValidationError("Enter a valid EVM address.");
  }
  if (solana && !isValidSolanaAddress(solana)) {
    throw new WalletAddressValidationError("Enter a valid Solana address.");
  }

  const wallets = [
    ethereum ? { chain: "ethereum", address: ethereum } : null,
    solana ? { chain: "solana", address: solana } : null,
  ].filter((wallet): wallet is { chain: string; address: string } => !!wallet);

  return `${WALLET_LINKING_BEGIN}
${JSON.stringify({ lastUpdated: now.toISOString(), wallets }, null, 2)}
${WALLET_LINKING_END}`;
}
