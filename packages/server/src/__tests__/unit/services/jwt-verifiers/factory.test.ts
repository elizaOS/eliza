/**
 * Unit tests for JWTVerifierFactory
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, spyOn } from 'bun:test';
import { JWTVerifierFactory, createJWTVerifier, getJWTConfigStatus } from '../../../../services/jwt-verifiers/factory';
import { logger } from '@elizaos/core';
import { generateKeyPair, exportSPKI } from 'jose';

describe('JWTVerifierFactory', () => {
  let loggerInfoSpy: ReturnType<typeof spyOn>;
  let validEd25519PublicKey: string;
  const originalEnv = process.env;

  beforeAll(async () => {
    // Generate a real Ed25519 keypair for testing
    const keypair = await generateKeyPair('EdDSA');
    validEd25519PublicKey = await exportSPKI(keypair.publicKey);
  });

  beforeEach(() => {
    // Reset environment
    process.env = { ...originalEnv };
    delete process.env.PRIVY_VERIFICATION_KEY;
    delete process.env.JWT_ED25519_PUBLIC_KEY;
    delete process.env.JWT_JWKS_URI;
    delete process.env.JWT_SECRET;

    // Spy on logger
    loggerInfoSpy = spyOn(logger, 'info');
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    loggerInfoSpy?.mockRestore();
  });

  describe('create()', () => {
    describe('Priority 1: Ed25519 (Privy)', () => {
      it('should create Ed25519Verifier when PRIVY_VERIFICATION_KEY is set', () => {
        process.env.PRIVY_VERIFICATION_KEY = validEd25519PublicKey;

        const verifier = JWTVerifierFactory.create();

        expect(verifier).not.toBeNull();
        expect(verifier?.getName()).toBe('Ed25519');
      });

      it('should create Ed25519Verifier when JWT_ED25519_PUBLIC_KEY is set', () => {
        process.env.JWT_ED25519_PUBLIC_KEY = validEd25519PublicKey;

        const verifier = JWTVerifierFactory.create();

        expect(verifier).not.toBeNull();
        expect(verifier?.getName()).toBe('Ed25519');
      });

      it('should prioritize PRIVY_VERIFICATION_KEY over JWT_ED25519_PUBLIC_KEY', () => {
        process.env.PRIVY_VERIFICATION_KEY = validEd25519PublicKey;
        process.env.JWT_ED25519_PUBLIC_KEY = validEd25519PublicKey;

        const verifier = JWTVerifierFactory.create();

        expect(verifier).not.toBeNull();
        expect(verifier?.getName()).toBe('Ed25519');
      });

      it('should prioritize Ed25519 over JWKS', () => {
        process.env.PRIVY_VERIFICATION_KEY = validEd25519PublicKey;
        process.env.JWT_JWKS_URI = 'https://test.com/.well-known/jwks.json';

        const verifier = JWTVerifierFactory.create();

        expect(verifier?.getName()).toBe('Ed25519');
        expect(verifier?.getName()).not.toBe('JWKS');
      });

      it('should prioritize Ed25519 over Secret', () => {
        process.env.PRIVY_VERIFICATION_KEY = validEd25519PublicKey;
        process.env.JWT_SECRET = 'test-secret';

        const verifier = JWTVerifierFactory.create();

        expect(verifier?.getName()).toBe('Ed25519');
        expect(verifier?.getName()).not.toBe('Secret');
      });
    });

    describe('Priority 2: JWKS', () => {
      it('should create JWKSVerifier when JWT_JWKS_URI is set', () => {
        process.env.JWT_JWKS_URI = 'https://test.com/.well-known/jwks.json';

        const verifier = JWTVerifierFactory.create();

        expect(verifier).not.toBeNull();
        expect(verifier?.getName()).toBe('JWKS');
      });

      it('should prioritize JWKS over Secret', () => {
        process.env.JWT_JWKS_URI = 'https://test.com/.well-known/jwks.json';
        process.env.JWT_SECRET = 'test-secret';

        const verifier = JWTVerifierFactory.create();

        expect(verifier?.getName()).toBe('JWKS');
        expect(verifier?.getName()).not.toBe('Secret');
      });

      it('should support Auth0 JWKS URI', () => {
        process.env.JWT_JWKS_URI = 'https://tenant.auth0.com/.well-known/jwks.json';

        const verifier = JWTVerifierFactory.create();

        expect(verifier?.getName()).toBe('JWKS');
      });

      it('should support Clerk JWKS URI', () => {
        process.env.JWT_JWKS_URI = 'https://clerk.example.com/.well-known/jwks.json';

        const verifier = JWTVerifierFactory.create();

        expect(verifier?.getName()).toBe('JWKS');
      });

      it('should support Supabase JWKS URI', () => {
        process.env.JWT_JWKS_URI = 'https://abc123.supabase.co/auth/v1/.well-known/jwks.json';

        const verifier = JWTVerifierFactory.create();

        expect(verifier?.getName()).toBe('JWKS');
      });

      it('should support Google JWKS URI', () => {
        process.env.JWT_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';

        const verifier = JWTVerifierFactory.create();

        expect(verifier?.getName()).toBe('JWKS');
      });
    });

    describe('Priority 3: Secret', () => {
      it('should create SecretVerifier when JWT_SECRET is set', () => {
        process.env.JWT_SECRET = 'test-secret-key';

        const verifier = JWTVerifierFactory.create();

        expect(verifier).not.toBeNull();
        expect(verifier?.getName()).toBe('Secret');
      });

      it('should accept any secret value', () => {
        process.env.JWT_SECRET = 'any-secret-value-works-123!@#';

        const verifier = JWTVerifierFactory.create();

        expect(verifier?.getName()).toBe('Secret');
      });
    });

    describe('Priority 4: Disabled', () => {
      it('should return null when no JWT configuration is provided', () => {
        // All env vars are undefined

        const verifier = JWTVerifierFactory.create();

        expect(verifier).toBeNull();
      });

      it('should return null when all env vars are empty strings', () => {
        process.env.PRIVY_VERIFICATION_KEY = '';
        process.env.JWT_ED25519_PUBLIC_KEY = '';
        process.env.JWT_JWKS_URI = '';
        process.env.JWT_SECRET = '';

        const verifier = JWTVerifierFactory.create();

        expect(verifier).toBeNull();
      });
    });
  });

  describe('getConfigStatus()', () => {
    it('should return Ed25519 status when PRIVY_VERIFICATION_KEY is set', () => {
      process.env.PRIVY_VERIFICATION_KEY = validEd25519PublicKey;

      const status = JWTVerifierFactory.getConfigStatus();

      expect(status.method).toBe('ed25519');
      expect(status.configured).toBe(true);
      expect(status.details).toContain('PRIVY_VERIFICATION_KEY');
    });

    it('should return Ed25519 status when JWT_ED25519_PUBLIC_KEY is set', () => {
      process.env.JWT_ED25519_PUBLIC_KEY = validEd25519PublicKey;

      const status = JWTVerifierFactory.getConfigStatus();

      expect(status.method).toBe('ed25519');
      expect(status.configured).toBe(true);
      expect(status.details).toContain('JWT_ED25519_PUBLIC_KEY');
    });

    it('should return JWKS status when JWT_JWKS_URI is set', () => {
      process.env.JWT_JWKS_URI = 'https://test.com/.well-known/jwks.json';

      const status = JWTVerifierFactory.getConfigStatus();

      expect(status.method).toBe('jwks');
      expect(status.configured).toBe(true);
      expect(status.details).toContain('JWKS URI');
      expect(status.details).toContain('https://test.com/.well-known/jwks.json');
    });

    it('should return Secret status when JWT_SECRET is set', () => {
      process.env.JWT_SECRET = 'test-secret';

      const status = JWTVerifierFactory.getConfigStatus();

      expect(status.method).toBe('secret');
      expect(status.configured).toBe(true);
      expect(status.details).toContain('shared secret');
    });

    it('should return disabled status when no config is set', () => {
      // No env vars set

      const status = JWTVerifierFactory.getConfigStatus();

      expect(status.method).toBe('disabled');
      expect(status.configured).toBe(false);
      expect(status.details).toContain('No JWT configuration found');
    });

    it('should follow priority order in status', () => {
      // Set all env vars
      process.env.PRIVY_VERIFICATION_KEY = validEd25519PublicKey;
      process.env.JWT_JWKS_URI = 'https://test.com/.well-known/jwks.json';
      process.env.JWT_SECRET = 'test-secret';

      const status = JWTVerifierFactory.getConfigStatus();

      // Should return Ed25519 (highest priority)
      expect(status.method).toBe('ed25519');
      expect(status.configured).toBe(true);
    });
  });

  describe('Real-world configuration examples', () => {
    it('should handle Privy production configuration', () => {
      process.env.PRIVY_VERIFICATION_KEY = validEd25519PublicKey;

      const verifier = JWTVerifierFactory.create();
      const status = JWTVerifierFactory.getConfigStatus();

      expect(verifier?.getName()).toBe('Ed25519');
      expect(status.method).toBe('ed25519');
      expect(status.details).toContain('PRIVY_VERIFICATION_KEY');
    });

    it('should handle Auth0 production configuration', () => {
      process.env.JWT_JWKS_URI = 'https://my-app.auth0.com/.well-known/jwks.json';

      const verifier = JWTVerifierFactory.create();
      const status = JWTVerifierFactory.getConfigStatus();

      expect(verifier?.getName()).toBe('JWKS');
      expect(status.method).toBe('jwks');
      expect(status.details).toContain('my-app.auth0.com');
    });

    it('should handle Clerk production configuration', () => {
      process.env.JWT_JWKS_URI = 'https://clerk.my-app.com/.well-known/jwks.json';

      const verifier = JWTVerifierFactory.create();
      const status = JWTVerifierFactory.getConfigStatus();

      expect(verifier?.getName()).toBe('JWKS');
      expect(status.method).toBe('jwks');
    });

    it('should handle custom JWT configuration', () => {
      process.env.JWT_SECRET = 'super-secret-key-for-production-use-256-bits';

      const verifier = JWTVerifierFactory.create();
      const status = JWTVerifierFactory.getConfigStatus();

      expect(verifier?.getName()).toBe('Secret');
      expect(status.method).toBe('secret');
    });

    it('should handle disabled configuration (open API)', () => {
      // No JWT env vars

      const verifier = JWTVerifierFactory.create();
      const status = JWTVerifierFactory.getConfigStatus();

      expect(verifier).toBeNull();
      expect(status.method).toBe('disabled');
      expect(status.configured).toBe(false);
    });
  });

  describe('Edge cases', () => {
    it('should handle whitespace-only env vars', () => {
      process.env.JWT_SECRET = '   ';

      const verifier = JWTVerifierFactory.create();

      // Whitespace-only is truthy, so it will create verifier
      expect(verifier?.getName()).toBe('Secret');
    });

    it('should handle multiline PRIVY_VERIFICATION_KEY', () => {
      process.env.PRIVY_VERIFICATION_KEY = validEd25519PublicKey;

      const verifier = JWTVerifierFactory.create();

      expect(verifier?.getName()).toBe('Ed25519');
    });

    it('should handle JWKS URI with query parameters', () => {
      process.env.JWT_JWKS_URI = 'https://test.com/.well-known/jwks.json?version=1.0';

      const verifier = JWTVerifierFactory.create();

      expect(verifier?.getName()).toBe('JWKS');
    });
  });

  describe('Multiple calls consistency', () => {
    it('should return same verifier type on multiple calls with same env', () => {
      process.env.PRIVY_VERIFICATION_KEY = validEd25519PublicKey;

      const verifier1 = JWTVerifierFactory.create();
      const verifier2 = JWTVerifierFactory.create();

      expect(verifier1?.getName()).toBe('Ed25519');
      expect(verifier2?.getName()).toBe('Ed25519');
      // Note: These will be different instances, not the same object
      expect(verifier1).not.toBe(verifier2);
    });

    it('should return consistent status on multiple calls', () => {
      process.env.JWT_JWKS_URI = 'https://test.com/.well-known/jwks.json';

      const status1 = JWTVerifierFactory.getConfigStatus();
      const status2 = JWTVerifierFactory.getConfigStatus();

      expect(status1).toEqual(status2);
      expect(status1.method).toBe('jwks');
      expect(status2.method).toBe('jwks');
    });
  });

  describe('Functional API', () => {
    it('createJWTVerifier should work like JWTVerifierFactory.create', () => {
      process.env.JWT_SECRET = 'test-secret';

      const verifier = createJWTVerifier();

      expect(verifier?.getName()).toBe('Secret');
    });

    it('getJWTConfigStatus should work like JWTVerifierFactory.getConfigStatus', () => {
      process.env.JWT_JWKS_URI = 'https://test.com/.well-known/jwks.json';

      const status = getJWTConfigStatus();

      expect(status.method).toBe('jwks');
      expect(status.configured).toBe(true);
    });
  });
});
