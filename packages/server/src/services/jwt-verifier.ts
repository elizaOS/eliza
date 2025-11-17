import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { logger, stringToUuid, type UUID } from '@elizaos/core';

/**
 * Universal JWT Verifier for ElizaOS.
 *
 * Supports two verification modes:
 * 1. JWKS (JSON Web Key Set) - For external providers (Privy, CDP, Auth0)
 * 2. Shared Secret - For self-signed tokens (custom auth)
 *
 * The verifier automatically generates a deterministic entityId from the JWT `sub` claim
 * using stringToUuid(). This ensures the same user always gets the same entityId.
 *
 * @example
 * // JWKS mode (Privy)
 * JWT_JWKS_URI=https://auth.privy.io/.well-known/jwks.json
 *
 * @example
 * // Secret mode (custom auth)
 * JWT_SECRET=your-secret-key
 */
export class UniversalJWTVerifier {
  private jwksClient?: jwksClient.JwksClient;
  private verificationMethod: 'jwks' | 'secret' | 'disabled';

  constructor() {
    const jwksUri = process.env.JWT_JWKS_URI;
    const secret = process.env.JWT_SECRET;

    if (jwksUri) {
      // JWKS mode - auto-fetch public keys from provider
      this.verificationMethod = 'jwks';
      this.jwksClient = jwksClient({
        jwksUri,
        cache: true,
        cacheMaxAge: 3600000, // 1 hour cache
        rateLimit: true,
        jwksRequestsPerMinute: 10,
      });
      logger.info(`[JWT] Using JWKS verification from: ${jwksUri}`);
    } else if (secret) {
      // Shared secret mode - self-signed tokens
      this.verificationMethod = 'secret';
      logger.info('[JWT] Using shared secret verification');
    } else {
      // JWT disabled - no authentication
      this.verificationMethod = 'disabled';
      logger.info('[JWT] JWT authentication disabled (no JWKS_URI or SECRET configured)');
    }
  }

  /**
   * Verify JWT token and return entityId.
   *
   * Takes any JWT from any provider, extracts `sub`, and generates entityId.
   *
   * @param token - JWT token string
   * @returns { entityId: UUID, sub: string, payload: any }
   * @throws Error if verification fails
   */
  async verify(token: string): Promise<{ entityId: UUID; sub: string; payload: any }> {
    if (this.verificationMethod === 'disabled') {
      throw new Error('JWT authentication is not configured');
    }

    try {
      let payload: any;

      if (this.verificationMethod === 'jwks') {
        payload = await this.verifyWithJWKS(token);
      } else {
        payload = this.verifyWithSecret(token);
      }

      // Extract sub (required)
      const sub = payload.sub;
      if (!sub) {
        throw new Error('JWT missing required claim: sub');
      }

      // Validate expiration
      if (payload.exp && payload.exp < Date.now() / 1000) {
        throw new Error('JWT expired');
      }

      // Optional: Validate issuer whitelist
      const issuerWhitelist = process.env.JWT_ISSUER_WHITELIST;
      if (issuerWhitelist && issuerWhitelist !== '*') {
        const allowedIssuers = issuerWhitelist.split(',').map((iss) => iss.trim());
        if (payload.iss && !allowedIssuers.includes(payload.iss)) {
          throw new Error(`Untrusted issuer: ${payload.iss}`);
        }
      }

      // Generate deterministic entityId from sub
      const entityId = stringToUuid(sub) as UUID;

      logger.debug(`[JWT] Verified token: ${sub} → entityId: ${entityId.substring(0, 8)}...`);

      return {
        entityId,
        sub,
        payload, // Full JWT payload for additional claims
      };
    } catch (error: any) {
      logger.error('[JWT] Verification failed:', error.message);
      throw new Error(`JWT verification failed: ${error.message}`);
    }
  }

  /**
   * Verify JWT with JWKS (public key from provider).
   * Used for external auth providers (Privy, CDP, Auth0).
   */
  private async verifyWithJWKS(token: string): Promise<any> {
    // Decode token to get key ID from header
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded) {
      throw new Error('Invalid JWT format');
    }

    // Fetch signing key from JWKS endpoint
    const kid = decoded.header.kid;
    if (!kid) {
      throw new Error('JWT header missing kid (key ID)');
    }

    const key = await this.jwksClient!.getSigningKey(kid);
    const publicKey = key.getPublicKey();

    // Verify signature with public key
    return jwt.verify(token, publicKey, {
      algorithms: ['RS256', 'ES256', 'PS256'], // Standard asymmetric algorithms
    });
  }

  /**
   * Verify JWT with shared secret.
   * Used for self-signed tokens (custom auth).
   */
  private verifyWithSecret(token: string): any {
    const secret = process.env.JWT_SECRET!;

    return jwt.verify(token, secret, {
      algorithms: ['HS256', 'HS384', 'HS512'], // HMAC algorithms
    });
  }

  /**
   * Check if JWT authentication is enabled.
   */
  isEnabled(): boolean {
    return this.verificationMethod !== 'disabled';
  }

  /**
   * Get current verification method.
   */
  getVerificationMethod(): 'jwks' | 'secret' | 'disabled' {
    return this.verificationMethod;
  }
}

// Singleton instance
export const jwtVerifier = new UniversalJWTVerifier();
