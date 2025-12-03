import { createRemoteJWKSet, jwtVerify } from 'jose';
import { logger, stringToUuid, type UUID } from '@elizaos/core';
import type { IJWTVerifier, JWTVerificationResult } from './base';

/**
 * JWKS (JSON Web Key Set) Verifier using jose library
 *
 * Supports any provider that exposes a JWKS endpoint:
 * - Auth0, Clerk, Supabase, Google, any OIDC provider
 */
export class JWKSVerifier implements IJWTVerifier {
  private jwks: ReturnType<typeof createRemoteJWKSet>;
  private jwksUri: string;

  constructor(jwksUri: string) {
    this.jwksUri = jwksUri;
    this.jwks = createRemoteJWKSet(new URL(jwksUri));
  }

  async verify(token: string): Promise<JWTVerificationResult> {
    try {
      const { payload } = await jwtVerify(token, this.jwks);

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

      const entityId = stringToUuid(sub) as UUID;

      return { entityId, sub, payload };
    } catch (error: any) {
      logger.error({ src: 'http', error: error.message }, 'JWKS JWT verification failed');
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
