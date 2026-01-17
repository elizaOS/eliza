import type { UUID } from '@elizaos/core';

/**
 * JWT Verification Result
 */
export interface JWTVerificationResult {
  entityId: UUID;
  sub: string;
  payload: any;
}

/**
 * Base interface for all JWT verifiers.
 *
 * This abstraction allows supporting multiple auth providers
 * with different verification methods (JWKS, Privy SDK, custom secret, etc.)
 */
export interface IJWTVerifier {
  /**
   * Verify a JWT token and return user information.
   *
   * @param token - JWT token string
   * @returns Verification result with entityId and payload
   * @throws Error if verification fails
   */
  verify(token: string): Promise<JWTVerificationResult>;

  /**
   * Get the name/type of this verifier for logging
   */
  getName(): string;

  /**
   * Check if this verifier is properly configured
   */
  isConfigured(): boolean;
}
