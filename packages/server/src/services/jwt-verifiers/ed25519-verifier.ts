import { importSPKI, jwtVerify } from 'jose';
import { logger, stringToUuid, type UUID } from '@elizaos/core';
import type { IJWTVerifier, JWTVerificationResult } from './base';

/**
 * Ed25519 Verifier using jose library
 *
 * Verifies JWT tokens signed with Ed25519 (EdDSA) algorithm.
 * This is used by Privy and other providers that use Ed25519 signing keys.
 *
 * No SDK required - just the public verification key from the provider dashboard.
 *
 * ## Privy Setup
 *
 * 1. Go to https://dashboard.privy.io/
 * 2. Select your app
 * 3. Navigate to "Configuration" → "App settings"
 * 4. Copy the "Verification key" (Ed25519 public key in PEM format)
 * 5. Set as PRIVY_VERIFICATION_KEY in .env
 *
 * @example Privy
 * PRIVY_VERIFICATION_KEY=-----BEGIN PUBLIC KEY-----
 * MCowBQYDK2VwAyEA...
 * -----END PUBLIC KEY-----
 *
 * Algorithm supported: EdDSA (Ed25519)
 */
export class Ed25519Verifier implements IJWTVerifier {
  private publicKey: Promise<any>; // CryptoKey from jose
  private verificationKey: string;

  constructor(verificationKey: string) {
    this.verificationKey = verificationKey;

    // Import Ed25519 public key (PEM format)
    // jose handles the conversion to CryptoKey
    this.publicKey = importSPKI(verificationKey, 'EdDSA');

    logger.info('[JWT:Ed25519] Initialized with Ed25519 public key');
  }

  async verify(token: string): Promise<JWTVerificationResult> {
    try {
      // Verify JWT with Ed25519 public key
      const { payload } = await jwtVerify(token, await this.publicKey, {
        algorithms: ['EdDSA'], // Ed25519 algorithm
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

      logger.debug(`[JWT:Ed25519] Verified token: ${sub} → entityId: ${entityId.substring(0, 8)}...`);

      return { entityId, sub, payload };
    } catch (error: any) {
      logger.error('[JWT:Ed25519] Verification failed:', error.message);
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
