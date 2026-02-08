import { jwtVerify } from 'jose';
import { logger, stringToUuid, type UUID } from '@elizaos/core';
import type { IJWTVerifier, JWTVerificationResult } from '../../types/jwt';
import { validateIssuer } from './issuer-validation';

/**
 * Create a Shared Secret Verifier using jose library
 *
 * For self-signed JWT tokens using HMAC (symmetric) algorithms.
 */
export function createSecretVerifier(secret: string): IJWTVerifier {
  const secretBytes = new TextEncoder().encode(secret);

  return {
    async verify(token: string): Promise<JWTVerificationResult> {
      try {
        const { payload } = await jwtVerify(token, secretBytes, {
          algorithms: ['HS256', 'HS384', 'HS512'],
        });

        const sub = payload.sub;
        if (!sub) {
          throw new Error('JWT missing required claim: sub');
        }

        validateIssuer(payload.iss);

        const entityId = stringToUuid(sub) as UUID;

        return { entityId, sub, payload };
      } catch (error: any) {
        logger.error({ src: 'http', error: error.message }, 'Secret JWT verification failed');
        throw new Error(`JWT verification failed: ${error.message}`);
      }
    },

    getName(): string {
      return 'Secret';
    },

    isConfigured(): boolean {
      return !!secret;
    },
  };
}

// Backwards compatibility - deprecated, use createSecretVerifier instead
export class SecretVerifier implements IJWTVerifier {
  private verifier: IJWTVerifier;

  constructor(secret: string) {
    this.verifier = createSecretVerifier(secret);
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
