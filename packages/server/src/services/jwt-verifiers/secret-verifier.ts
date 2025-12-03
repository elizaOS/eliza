import { jwtVerify } from 'jose';
import { logger, stringToUuid, type UUID } from '@elizaos/core';
import type { IJWTVerifier, JWTVerificationResult } from './base';

/**
 * Shared Secret Verifier using jose library
 *
 * For self-signed JWT tokens using HMAC (symmetric) algorithms.
 */
export class SecretVerifier implements IJWTVerifier {
  private secret: Uint8Array;

  constructor(secret: string) {
    this.secret = new TextEncoder().encode(secret);
  }

  async verify(token: string): Promise<JWTVerificationResult> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        algorithms: ['HS256', 'HS384', 'HS512'],
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
      logger.error({ src: 'http', error: error.message }, 'Secret JWT verification failed');
      throw new Error(`JWT verification failed: ${error.message}`);
    }
  }

  getName(): string {
    return 'Secret';
  }

  isConfigured(): boolean {
    return !!this.secret;
  }
}
