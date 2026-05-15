/**
 * Solana address validation utilities
 */

import { isValidSolanaAddress } from "./address-validation";

export { isValidSolanaAddress } from "./address-validation";

/**
 * Validates Solana address and throws descriptive error if invalid
 *
 * @param address - The address to validate
 * @throws Error with user-friendly message if invalid
 */
export function validateSolanaAddress(address: string): void {
  if (!isValidSolanaAddress(address)) {
    throw new Error(
      "Invalid Solana address. Must be a valid base58-encoded public key (32 bytes).",
    );
  }
}
