import { importSPKI, jwtVerify } from 'jose';
import { logger, stringToUuid, type UUID } from '@elizaos/core';
import type { IJWTVerifier, JWTVerificationResult } from './base';

/**
 * Ed25519 Verifier using jose library
 *
 * Verifies JWT tokens signed with Ed25519 (EdDSA) algorithm.
 * Used by Privy and other providers that use Ed25519 signing keys.
 */
export class Ed25519Verifier implements IJWTVerifier {
  private publicKey: Promise<any>;
  private verificationKey: string;

  constructor(verificationKey: string) {
    this.verificationKey = verificationKey;
    this.publicKey = importSPKI(verificationKey, 'EdDSA');
  }

  async verify(token: string): Promise<JWTVerificationResult> {
    try {
      const { payload } = await jwtVerify(token, await this.publicKey, {
        algorithms: ['EdDSA'],
      });

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
      logger.error({ src: 'http', error: error.message }, 'Ed25519 JWT verification failed');
      throw new Error(`Ed25519 JWT verification failed: ${error.message}`);
    }
  }

  getName(): string {
    return 'Ed25519';
  }

  isConfigured(): boolean {
    return !!this.verificationKey;
  }
}
