/**
 * API Key Generation and Validation
 *
 * @description Secure API key management for external agent authentication.
 * Provides functions for generating, hashing, and verifying API keys using
 * cryptographically secure random generation and SHA-256 hashing.
 */

import crypto from "node:crypto";

/**
 * Generate a secure random API key
 *
 * @description Generates a cryptographically secure random API key for external
 * agent authentication. Format: bab_live_<32 random hex characters>.
 *
 * @returns {string} A new API key string in format bab_live_<hex>
 *
 * @example
 * ```typescript
 * const apiKey = generateApiKey();
 * // Returns: "bab_live_a1b2c3d4e5f6..."
 * ```
 */
export function generateApiKey(): string {
  const randomBytes = crypto.randomBytes(32);
  const hex = randomBytes.toString("hex");
  return `bab_live_${hex}`;
}

/**
 * Hash an API key for secure storage
 *
 * @description Creates a SHA-256 one-way hash of an API key for secure storage.
 * The original key cannot be recovered from the hash. Used to store API keys
 * in the database without exposing plaintext keys.
 *
 * @param {string} apiKey - The API key to hash
 * @returns {string} Hashed API key (hex string)
 *
 * @example
 * ```typescript
 * const hash = hashApiKey('bab_live_abc123...');
 * // Store hash in database, never store plaintext key
 * ```
 */
export function hashApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Verify an API key against a stored hash
 *
 * @description Verifies that an API key matches a stored hash using timing-safe
 * comparison to prevent timing attacks. Used during authentication to validate
 * API keys without storing plaintext keys.
 *
 * @param {string} apiKey - The API key to verify
 * @param {string} storedHash - The stored hash to compare against
 * @returns {boolean} True if the API key matches the hash
 *
 * @example
 * ```typescript
 * const isValid = verifyApiKey(providedKey, storedHash);
 * if (isValid) {
 *   // Authenticate agent
 * }
 * ```
 */
export function verifyApiKey(apiKey: string, storedHash: string): boolean {
  const inputHash = hashApiKey(apiKey);
  return crypto.timingSafeEqual(
    Buffer.from(inputHash),
    Buffer.from(storedHash),
  );
}

/**
 * Generate a test API key for development
 *
 * @description Generates a test API key for development and testing purposes.
 * Format: bab_test_<32 random hex characters>. Should not be used in production.
 *
 * @returns {string} A test API key string in format bab_test_<hex>
 *
 * @example
 * ```typescript
 * const testKey = generateTestApiKey();
 * // Returns: "bab_test_a1b2c3d4e5f6..."
 * ```
 */
export function generateTestApiKey(): string {
  const randomBytes = crypto.randomBytes(32);
  const hex = randomBytes.toString("hex");
  return `bab_test_${hex}`;
}
