/**
 * Utilities for generating and verifying invite tokens.
 */

import crypto from "crypto";

/**
 * Generates a cryptographically secure invite token.
 *
 * @returns 64-character hexadecimal token.
 */
export function generateInviteToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Hashes an invite token using SHA-256.
 *
 * @param token - Token to hash.
 * @returns SHA-256 hash of the token.
 */
export function hashInviteToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Verifies an invite token against its hash.
 *
 * @param token - Token to verify.
 * @param hash - Expected hash of the token.
 * @returns True if the token matches the hash.
 */
export function verifyInviteToken(token: string, hash: string): boolean {
  return hashInviteToken(token) === hash;
}
