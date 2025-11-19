import { createRemoteJWKSet, jwtVerify } from 'jose';
import { logger, stringToUuid, type UUID } from '@elizaos/core';
import type { IJWTVerifier, JWTVerificationResult } from './base';

/**
 * JWKS (JSON Web Key Set) Verifier using jose library
 *
 * Supports any provider that exposes a JWKS endpoint:
 *
 * - Auth0: https://{yourDomain}/.well-known/jwks.json
 * - Clerk: https://{frontendAPI}/.well-known/jwks.json
 * - Supabase: https://{projectRef}.supabase.co/auth/v1/.well-known/jwks.json
 *   (Note: Only for projects with asymmetric keys RS256/ES256/Ed25519, not legacy HS256)
 * - Google: https://www.googleapis.com/oauth2/v3/certs
 * - Any OpenID Connect compatible provider
 *
 * Algorithms supported: RS256, RS384, RS512, ES256, ES384, ES512, PS256, PS384, PS512, EdDSA
 *
 * @example Auth0
 * JWT_JWKS_URI=https://your-tenant.auth0.com/.well-known/jwks.json
 *
 * @example Clerk
 * JWT_JWKS_URI=https://clerk.your-app.com/.well-known/jwks.json
 *
 * @example Supabase (asymmetric keys only)
 * JWT_JWKS_URI=https://abc123.supabase.co/auth/v1/.well-known/jwks.json
 *
 * @example Google
 * JWT_JWKS_URI=https://www.googleapis.com/oauth2/v3/certs
 */
export class JWKSVerifier implements IJWTVerifier {
  private jwks: ReturnType<typeof createRemoteJWKSet>;
  private jwksUri: string;

  constructor(jwksUri: string) {
    this.jwksUri = jwksUri;
    // createRemoteJWKSet automatically fetches and caches keys
    this.jwks = createRemoteJWKSet(new URL(jwksUri));

    logger.info(`[JWT:JWKS] Initialized with endpoint: ${jwksUri}`);
  }

  async verify(token: string): Promise<JWTVerificationResult> {
    try {
      // Verify JWT with remote JWKS
      const { payload } = await jwtVerify(token, this.jwks, {
        // jose automatically handles algorithm detection from JWT header
      });

      // Extract sub (required)
      const sub = payload.sub;
      if (!sub) {
        throw new Error('JWT missing required claim: sub');
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

      logger.debug(`[JWT:JWKS] Verified token: ${sub} → entityId: ${entityId.substring(0, 8)}...`);

      return { entityId, sub, payload };
    } catch (error: any) {
      logger.error('[JWT:JWKS] Verification failed:', error.message);
      throw new Error(`JWT verification failed: ${error.message}`);
    }
  }

  getName(): string {
    return 'JWKS';
  }

  isConfigured(): boolean {
    return !!this.jwksUri;
  }
}
