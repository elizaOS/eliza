import { importSPKI, jwtVerify } from 'jose';
import { logger, stringToUuid, type UUID } from '@elizaos/core';
import type { IJWTVerifier, JWTVerificationResult } from '../../types/jwt';
import { validateIssuer } from './issuer-validation';

/**
 * Create an Ed25519 Verifier using jose library
 *
 * Verifies JWT tokens signed with Ed25519 (EdDSA) algorithm.
 * Used by Privy and other providers that use Ed25519 signing keys.
 */
export function createEd25519Verifier(verificationKey: string): IJWTVerifier {
  const publicKey = importSPKI(verificationKey, 'EdDSA');

  return {
    async verify(token: string): Promise<JWTVerificationResult> {
      try {
        const { payload } = await jwtVerify(token, await publicKey, {
          algorithms: ['EdDSA'],
        });

        const sub = payload.sub;
        if (!sub) {
          throw new Error('JWT missing required claim: sub');
        }

        validateIssuer(payload.iss);

        const entityId = stringToUuid(sub) as UUID;

        return { entityId, sub, payload };
      } catch (error: any) {
        logger.error({ src: 'http', error: error.message }, 'Ed25519 JWT verification failed');
        throw new Error(`Ed25519 JWT verification failed: ${error.message}`);
      }
    },

    getName(): string {
      return 'Ed25519';
    },

    isConfigured(): boolean {
      return !!verificationKey;
    },
  };
}

// Backwards compatibility - deprecated, use createEd25519Verifier instead
export class Ed25519Verifier implements IJWTVerifier {
  private verifier: IJWTVerifier;

  constructor(verificationKey: string) {
    this.verifier = createEd25519Verifier(verificationKey);
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
