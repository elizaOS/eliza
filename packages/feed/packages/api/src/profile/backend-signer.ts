/**
 * Backend Profile Signer
 *
 * Previously used for on-chain profile updates, but this approach had issues
 * with contract ownership verification (msg.sender != user wallet).
 *
 * The new approach:
 * 1. Profile updates are saved directly to the database
 * 2. A separate background job syncs database state to on-chain
 *
 * This file is kept for backwards compatibility and utility functions.
 */

import { logger } from "@feed/shared";
import type { Address } from "viem";

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
 *
 * @deprecated On-chain profile updates via backend signing are disabled.
 * Profile updates now save to database directly and sync to chain via background job.
 */
export function isBackendSigningEnabled(): boolean {
  // Always return false - on-chain updates via backend signing are disabled
  // Profile updates are now database-first with separate chain sync
  return false;
}

/**
 * Update user profile by signing the transaction server-side
 *
 * @deprecated This function is disabled. Profile updates should be saved to database
 * directly via the update-profile API route. Chain sync happens separately.
 *
 * @param params - Profile update parameters
 * @returns Transaction hash and metadata
 * @throws Error - Always throws as this method is deprecated
 */
export async function updateProfileBackendSigned(
  _params: BackendSignedUpdateParams,
): Promise<BackendSignedUpdateResult> {
  logger.warn(
    "updateProfileBackendSigned is deprecated - profile updates are now database-first",
    {},
    "BackendSigner",
  );

  throw new Error(
    "Backend-signed on-chain profile updates are disabled. " +
      "Profile updates are saved to the database and synced to chain via background job.",
  );
}

/**
 * Verify a backend-signed transaction was successful
 *
 * @deprecated This function will be removed in a future version.
 *
 * @param _txHash - Transaction hash to verify
 * @returns Always returns false as backend signing is disabled
 */
export async function verifyBackendSignedUpdate(
  _txHash: `0x${string}`,
): Promise<boolean> {
  logger.warn("verifyBackendSignedUpdate is deprecated", {}, "BackendSigner");
  return false;
}
