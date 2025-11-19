import { jwtVerify } from 'jose';
import { logger, stringToUuid, type UUID } from '@elizaos/core';
import type { IJWTVerifier, JWTVerificationResult } from './base';

/**
 * Shared Secret Verifier using jose library
 *
 * For self-signed JWT tokens using HMAC (symmetric) algorithms.
 * Useful for custom authentication or legacy Supabase projects using HS256.
 *
 * Algorithms supported: HS256, HS384, HS512
 *
 * @example
 * JWT_SECRET=your-256-bit-secret-key-here
 */
export class SecretVerifier implements IJWTVerifier {
  private secret: Uint8Array;

  constructor(secret: string) {
    // Convert string secret to Uint8Array for jose
    this.secret = new TextEncoder().encode(secret);
    logger.info('[JWT:Secret] Initialized with shared secret');
  }

  async verify(token: string): Promise<JWTVerificationResult> {
    try {
      // Verify with shared secret
      const { payload } = await jwtVerify(token, this.secret, {
        algorithms: ['HS256', 'HS384', 'HS512'], // HMAC algorithms
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

      logger.debug(`[JWT:Secret] Verified token: ${sub} → entityId: ${entityId.substring(0, 8)}...`);

      return { entityId, sub, payload };
    } catch (error: any) {
      logger.error('[JWT:Secret] Verification failed:', error.message);
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
