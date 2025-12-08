import { logger } from '@elizaos/core';
import { createJWTVerifier, getJWTConfigStatus } from './jwt-verifiers/factory';
import type { JWTVerificationResult } from '../types/jwt';

export interface UniversalJWTVerifierInstance {
  verify(token: string): Promise<JWTVerificationResult>;
  isEnabled(): boolean;
  getVerificationMethod(): string;
}

/**
 * Create a Universal JWT Verifier for ElizaOS.
 *
 * Supports multiple verification methods through a pluggable architecture:
 * - Ed25519 (Privy and other Ed25519-based providers)
 * - JWKS (Auth0, Clerk, Supabase, Google, etc.)
 * - Shared Secret (Custom HMAC tokens)
 */
export function createUniversalJWTVerifier(): UniversalJWTVerifierInstance {
  const verifier = createJWTVerifier();
  const status = getJWTConfigStatus();

  if (verifier) {
    logger.info({ src: 'http', method: status.method }, 'JWT authentication enabled');
  }

  return {
    /**
     * Verify JWT token and return entityId.
     */
    async verify(token: string): Promise<JWTVerificationResult> {
      if (!verifier) {
        throw new Error('JWT authentication is not configured');
      }
      return verifier.verify(token);
    },

    /**
     * Check if JWT authentication is enabled.
     */
    isEnabled(): boolean {
      return verifier !== null && verifier.isConfigured();
    },

    /**
     * Get current verification method.
     */
    getVerificationMethod(): string {
      return verifier?.getName() || 'disabled';
    },
  };
}

// Backwards compatibility - deprecated, use createUniversalJWTVerifier instead
export class UniversalJWTVerifier {
  private instance: UniversalJWTVerifierInstance;

  constructor() {
    this.instance = createUniversalJWTVerifier();
  }

  verify(token: string): Promise<JWTVerificationResult> {
    return this.instance.verify(token);
  }

  isEnabled(): boolean {
    return this.instance.isEnabled();
  }

  getVerificationMethod(): string {
    return this.instance.getVerificationMethod();
  }
}

// Singleton instance
export const jwtVerifier = createUniversalJWTVerifier();
