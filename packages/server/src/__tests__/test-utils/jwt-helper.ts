/**
 * JWT Test Helper - Utilities for creating test JWTs
 *
 * Centralizes JWT creation for testing authentication flows.
 * Supports Ed25519 (Privy) and HS256 (Secret/Supabase) algorithms.
 *
 * @example
 * ```typescript
 * // Create Ed25519 signed token
 * const { token, keypair, publicKey } = await JWTTestHelper.createEd25519Token({
 *   sub: 'did:privy:user123',
 *   claims: { app_id: 'my-app' }
 * });
 *
 * // Create HS256 signed token
 * const { token } = await JWTTestHelper.createSecretToken({
 *   sub: 'user@example.com',
 *   secret: 'my-secret-key'
 * });
 * ```
 */

import { SignJWT, generateKeyPair, exportSPKI } from 'jose';
import type { KeyLike } from 'jose';

export interface Ed25519TokenOptions {
  /** Subject claim (required) */
  sub: string;
  /** Additional JWT claims */
  claims?: Record<string, unknown>;
  /** Token issuer */
  issuer?: string;
  /** Token expiration (default: '1h') */
  expiresIn?: string;
  /** Use existing keypair instead of generating new one */
  keypair?: { publicKey: KeyLike; privateKey: KeyLike };
}

export interface Ed25519TokenResult {
  /** Signed JWT token */
  token: string;
  /** Generated or provided keypair */
  keypair: { publicKey: KeyLike; privateKey: KeyLike };
  /** PEM-encoded public key (for PRIVY_VERIFICATION_KEY) */
  publicKey: string;
}

export interface SecretTokenOptions {
  /** Subject claim (required) */
  sub: string;
  /** Shared secret for signing */
  secret: string;
  /** Additional JWT claims */
  claims?: Record<string, unknown>;
  /** Token issuer */
  issuer?: string;
  /** Token expiration (default: '1h') */
  expiresIn?: string;
  /** Token audience */
  audience?: string;
}

export interface SecretTokenResult {
  /** Signed JWT token */
  token: string;
  /** Secret used for signing */
  secret: string;
}

/**
 * Helper class for creating test JWTs
 */
export class JWTTestHelper {
  /**
   * Create an Ed25519 (EdDSA) signed JWT token
   * Used for Privy-style authentication
   */
  static async createEd25519Token(
    options: Ed25519TokenOptions
  ): Promise<Ed25519TokenResult> {
    const { sub, claims = {}, issuer = 'https://auth.privy.io', expiresIn = '1h' } = options;

    // Generate or use existing keypair
    const keypair = options.keypair ?? (await generateKeyPair('EdDSA'));
    const publicKey = await exportSPKI(keypair.publicKey);

    // Build and sign token
    const token = await new SignJWT({ sub, ...claims })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(sub)
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(keypair.privateKey);

    return { token, keypair, publicKey };
  }

  /**
   * Create an HS256 (shared secret) signed JWT token
   * Used for custom auth or Supabase-style authentication
   */
  static async createSecretToken(options: SecretTokenOptions): Promise<SecretTokenResult> {
    const {
      sub,
      secret,
      claims = {},
      issuer = 'custom-auth-server',
      expiresIn = '1h',
      audience,
    } = options;

    const secretBytes = new TextEncoder().encode(secret);

    // Build token
    let builder = new SignJWT({ sub, ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sub)
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime(expiresIn);

    if (audience) {
      builder = builder.setAudience(audience);
    }

    const token = await builder.sign(secretBytes);

    return { token, secret };
  }

  /**
   * Create a Privy-style token with common claims
   */
  static async createPrivyToken(options: {
    userId: string;
    appId?: string;
    linkedAccounts?: string[];
    keypair?: { publicKey: KeyLike; privateKey: KeyLike };
  }): Promise<Ed25519TokenResult> {
    const { userId, appId = 'test-app-id', linkedAccounts = [], keypair } = options;

    return this.createEd25519Token({
      sub: `did:privy:${userId}`,
      claims: {
        app_id: appId,
        linked_accounts: linkedAccounts,
      },
      keypair,
    });
  }

  /**
   * Create a Supabase-style token with common claims
   */
  static async createSupabaseToken(options: {
    userId: string;
    email?: string;
    role?: string;
    secret: string;
  }): Promise<SecretTokenResult> {
    const { userId, email, role = 'authenticated', secret } = options;

    return this.createSecretToken({
      sub: userId,
      secret,
      claims: {
        aud: 'authenticated',
        role,
        ...(email && { email }),
      },
      issuer: 'https://project.supabase.co/auth/v1',
      audience: 'authenticated',
    });
  }

  /**
   * Create an expired token for testing expiration handling
   */
  static async createExpiredToken(
    options: Omit<SecretTokenOptions, 'expiresIn'>
  ): Promise<SecretTokenResult> {
    return this.createSecretToken({
      ...options,
      expiresIn: '-1h', // Already expired
    });
  }

  /**
   * Create a token without sub claim for testing validation
   */
  static async createTokenWithoutSub(secret: string): Promise<string> {
    const secretBytes = new TextEncoder().encode(secret);

    const token = await new SignJWT({ email: 'user@example.com' })
      .setProtectedHeader({ alg: 'HS256' })
      // Intentionally NOT setting subject
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secretBytes);

    return token;
  }
}
