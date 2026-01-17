import { createRemoteJWKSet, jwtVerify } from 'jose';
import { logger, stringToUuid, type UUID } from '@elizaos/core';
import type { IJWTVerifier, JWTVerificationResult } from '../../types/jwt';
import { validateIssuer } from './issuer-validation';

/**
 * Create a JWKS (JSON Web Key Set) Verifier using jose library
 *
 * Supports any provider that exposes a JWKS endpoint:
 * - Auth0, Clerk, Supabase, Google, any OIDC provider
 */
export function createJWKSVerifier(jwksUri: string): IJWTVerifier {
  const jwks = createRemoteJWKSet(new URL(jwksUri));

  return {
    async verify(token: string): Promise<JWTVerificationResult> {
      try {
        const { payload } = await jwtVerify(token, jwks);

        const sub = payload.sub;
        if (!sub) {
          throw new Error('JWT missing required claim: sub');
        }

        validateIssuer(payload.iss);

        const entityId = stringToUuid(sub) as UUID;

        return { entityId, sub, payload };
      } catch (error: any) {
        logger.error({ src: 'http', error: error.message }, 'JWKS JWT verification failed');
        throw new Error(`JWT verification failed: ${error.message}`);
      }
    },

    getName(): string {
      return 'JWKS';
    },

    isConfigured(): boolean {
      return !!jwksUri;
    },
  };
}

// Backwards compatibility - deprecated, use createJWKSVerifier instead
export class JWKSVerifier implements IJWTVerifier {
  private verifier: IJWTVerifier;

  constructor(jwksUri: string) {
    this.verifier = createJWKSVerifier(jwksUri);
  }

  verify(token: string): Promise<JWTVerificationResult> {
    return this.verifier.verify(token);
  }

  getName(): string {
    return this.verifier.getName();
  }

  isConfigured(): boolean {
    return this.verifier.isConfigured();
  }
}
