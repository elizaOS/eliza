/**
 * JWT Verifiers Module
 *
 * Provides a flexible, extensible JWT verification system supporting multiple providers:
 * - Ed25519 (Privy and other Ed25519-based providers)
 * - JWKS providers (Auth0, Clerk, Supabase, Google, etc.)
 * - Custom shared secret (HMAC)
 *
 * All verifiers use the modern `jose` library for JWT operations.
 * The factory automatically selects the appropriate verifier based on environment variables.
 */

export type { IJWTVerifier, JWTVerificationResult } from '../../types/jwt';
export * from './ed25519-verifier';
export * from './jwks-verifier';
export * from './secret-verifier';
export * from './factory';
