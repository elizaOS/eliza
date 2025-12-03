import { logger } from '@elizaos/core';
import { JWTVerifierFactory } from './jwt-verifiers/factory';
import type { IJWTVerifier, JWTVerificationResult } from './jwt-verifiers/base';

/**
 * Universal JWT Verifier for ElizaOS.
 *
 * Supports multiple verification methods through a pluggable architecture:
 * - Ed25519 (Privy and other Ed25519-based providers)
 * - JWKS (Auth0, Clerk, Supabase, Google, etc.)
 * - Shared Secret (Custom HMAC tokens)
 */
export class UniversalJWTVerifier {
  private verifier: IJWTVerifier | null;

  constructor() {
    this.verifier = JWTVerifierFactory.create();
    const status = JWTVerifierFactory.getConfigStatus();

    if (this.verifier) {
      logger.info({ src: 'http', method: status.method }, 'JWT authentication enabled');
    }
  }

  /**
   * Verify JWT token and return entityId.
   */
  async verify(token: string): Promise<JWTVerificationResult> {
    if (!this.verifier) {
      throw new Error('JWT authentication is not configured');
    }

    return this.verifier.verify(token);
  }

  /**
   * Check if JWT authentication is enabled.
   */
  isEnabled(): boolean {
    return this.verifier !== null && this.verifier.isConfigured();
  }

  /**
   * Get current verification method.
   */
  getVerificationMethod(): string {
    return this.verifier?.getName() || 'disabled';
  }
}

// Singleton instance
export const jwtVerifier = new UniversalJWTVerifier();
