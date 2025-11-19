import { logger } from '@elizaos/core';
import { JWTVerifierFactory } from './jwt-verifiers/factory';
import type { IJWTVerifier, JWTVerificationResult } from './jwt-verifiers/base';

/**
 * Universal JWT Verifier for ElizaOS.
 *
 * Supports multiple verification methods through a pluggable architecture using the `jose` library:
 *
 * 1. **Ed25519** (Privy and other Ed25519-based providers)
 *    - Uses public verification key (PEM format)
 *    - No SDK required - just the verification key from provider dashboard
 *    - Algorithm: EdDSA (Ed25519)
 *
 * 2. **JWKS** (Standard OAuth providers)
 *    - Auth0: https://{domain}/.well-known/jwks.json
 *    - Clerk: https://{frontendAPI}/.well-known/jwks.json
 *    - Supabase: https://{project}.supabase.co/auth/v1/.well-known/jwks.json
 *    - Google: https://www.googleapis.com/oauth2/v3/certs
 *    - Algorithms: RS256, ES256, PS256, EdDSA
 *
 * 3. **Shared Secret** (Custom HMAC tokens)
 *    - For self-signed tokens or legacy systems
 *    - Algorithms: HS256, HS384, HS512
 *
 * The verifier automatically generates a deterministic entityId from the JWT `sub` claim
 * using stringToUuid(). This ensures the same user always gets the same entityId.
 *
 * ## Configuration Priority
 *
 * 1. **Privy / Ed25519** (highest priority)
 *    ```bash
 *    PRIVY_VERIFICATION_KEY=-----BEGIN PUBLIC KEY-----
 *    MCowBQYDK2VwAyEA...
 *    -----END PUBLIC KEY-----
 *    ```
 *
 * 2. **JWKS** (standard providers)
 *    ```bash
 *    JWT_JWKS_URI=https://your-domain/.well-known/jwks.json
 *    ```
 *
 * 3. **Secret** (custom auth)
 *    ```bash
 *    JWT_SECRET=your-256-bit-secret-key
 *    ```
 *
 * ## Optional Configuration
 *
 * ```bash
 * # Whitelist specific issuers (comma-separated)
 * JWT_ISSUER_WHITELIST=https://auth.privy.io,https://clerk.your-app.com
 *
 * # Or allow all issuers
 * JWT_ISSUER_WHITELIST=*
 * ```
 *
 * ## Examples
 *
 * @example Privy (Ed25519 - no SDK needed!)
 * ```bash
 * # Get verification key from: https://dashboard.privy.io/ → Configuration → App settings
 * PRIVY_VERIFICATION_KEY=-----BEGIN PUBLIC KEY-----
 * MCowBQYDK2VwAyEA...
 * -----END PUBLIC KEY-----
 * ```
 *
 * @example Auth0
 * ```bash
 * JWT_JWKS_URI=https://your-tenant.auth0.com/.well-known/jwks.json
 * ```
 *
 * @example Clerk
 * ```bash
 * JWT_JWKS_URI=https://clerk.your-app.com/.well-known/jwks.json
 * ```
 *
 * @example Supabase
 * ```bash
 * JWT_JWKS_URI=https://abc123.supabase.co/auth/v1/.well-known/jwks.json
 * ```
 *
 * @example Custom Secret
 * ```bash
 * JWT_SECRET=your-secret-key
 * ```
 */
export class UniversalJWTVerifier {
  private verifier: IJWTVerifier | null;

  constructor() {
    // Create appropriate verifier using factory
    this.verifier = JWTVerifierFactory.create();

    if (this.verifier) {
      logger.info(`[JWT] Authentication enabled using ${this.verifier.getName()} verifier`);
    } else {
      logger.info('[JWT] Authentication disabled (no verifier configured)');
    }

    // Log configuration status
    const status = JWTVerifierFactory.getConfigStatus();
    logger.debug(`[JWT] Config: ${status.method} - ${status.details}`);
  }

  /**
   * Verify JWT token and return entityId.
   *
   * Takes any JWT from any provider, extracts `sub`, and generates entityId.
   *
   * @param token - JWT token string
   * @returns { entityId: UUID, sub: string, payload: any }
   * @throws Error if verification fails or JWT is disabled
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
