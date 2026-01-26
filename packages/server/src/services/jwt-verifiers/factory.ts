import type { IJWTVerifier } from '../../types/jwt';
import { createEd25519Verifier } from './ed25519-verifier';
import { createJWKSVerifier } from './jwks-verifier';
import { createSecretVerifier } from './secret-verifier';

export type JWTVerifierMethod = 'ed25519' | 'jwks' | 'secret' | 'disabled';

export interface JWTConfigStatus {
  method: JWTVerifierMethod;
  configured: boolean;
  details: string;
}

/**
 * Create the appropriate JWT verifier based on environment configuration.
 *
 * Priority order:
 * 1. Ed25519 (if PRIVY_VERIFICATION_KEY or JWT_ED25519_PUBLIC_KEY)
 * 2. JWKS (if JWT_JWKS_URI)
 * 3. Secret (if JWT_SECRET)
 * 4. null (if none configured)
 */
export function createJWTVerifier(): IJWTVerifier | null {
  const privyVerificationKey = process.env.PRIVY_VERIFICATION_KEY;
  const ed25519PublicKey = process.env.JWT_ED25519_PUBLIC_KEY;
  const jwksUri = process.env.JWT_JWKS_URI;
  const jwtSecret = process.env.JWT_SECRET;

  // Priority 1: Ed25519 (Privy or other Ed25519 providers)
  const ed25519Key = privyVerificationKey || ed25519PublicKey;
  if (ed25519Key) {
    return createEd25519Verifier(ed25519Key);
  }

  // Priority 2: JWKS (Auth0, Clerk, Supabase, Google, etc.)
  if (jwksUri) {
    return createJWKSVerifier(jwksUri);
  }

  // Priority 3: Shared Secret (custom auth)
  if (jwtSecret) {
    return createSecretVerifier(jwtSecret);
  }

  return null;
}

/**
 * Get configuration status for debugging.
 */
export function getJWTConfigStatus(): JWTConfigStatus {
  const privyVerificationKey = process.env.PRIVY_VERIFICATION_KEY;
  const ed25519PublicKey = process.env.JWT_ED25519_PUBLIC_KEY;
  const jwksUri = process.env.JWT_JWKS_URI;
  const jwtSecret = process.env.JWT_SECRET;

  const ed25519Key = privyVerificationKey || ed25519PublicKey;
  if (ed25519Key) {
    const source = privyVerificationKey ? 'PRIVY_VERIFICATION_KEY' : 'JWT_ED25519_PUBLIC_KEY';
    return {
      method: 'ed25519',
      configured: true,
      details: `Using ${source}`,
    };
  }

  if (jwksUri) {
    return {
      method: 'jwks',
      configured: true,
      details: `JWKS URI: ${jwksUri}`,
    };
  }

  if (jwtSecret) {
    return {
      method: 'secret',
      configured: true,
      details: 'Using shared secret',
    };
  }

  return {
    method: 'disabled',
    configured: false,
    details: 'No JWT configuration found',
  };
}

// Backwards compatibility - deprecated, use createJWTVerifier and getJWTConfigStatus instead
export class JWTVerifierFactory {
  static create(): IJWTVerifier | null {
    return createJWTVerifier();
  }

  static getConfigStatus(): JWTConfigStatus {
    return getJWTConfigStatus();
  }
}
