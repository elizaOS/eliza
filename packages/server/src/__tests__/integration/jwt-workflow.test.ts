/**
 * Integration tests for complete JWT authentication workflow
 *
 * Tests the full flow from token generation → verification → entityId generation
 * across all supported providers (Ed25519, JWKS, Secret)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { UniversalJWTVerifier } from '../../services/jwt-verifier';
import { stringToUuid } from '@elizaos/core';
import { SignJWT, generateKeyPair, exportSPKI } from 'jose';
import {
  setupTestEnvironment,
  teardownTestEnvironment,
  type EnvironmentSnapshot,
} from '../test-utils/environment';
import { JWTTestHelper } from '../test-utils/jwt-helper';

describe('JWT Authentication Workflow Integration', () => {
  let envSnapshot: EnvironmentSnapshot;

  beforeEach(() => {
    // Use centralized environment setup
    envSnapshot = setupTestEnvironment();
    // Clear JWT-specific env vars
    delete process.env.PRIVY_VERIFICATION_KEY;
    delete process.env.JWT_ED25519_PUBLIC_KEY;
    delete process.env.JWT_JWKS_URI;
    delete process.env.JWT_SECRET;
    delete process.env.JWT_ISSUER_WHITELIST;
    delete process.env.ENABLE_DATA_ISOLATION;
  });

  afterEach(() => {
    // Use centralized environment teardown
    teardownTestEnvironment(envSnapshot);
  });

  describe('End-to-end: Ed25519 (Privy) workflow', () => {
    it('should complete full authentication flow with Ed25519', async () => {
      // 1. Setup using JWTTestHelper (simulating Privy setup)
      const { token, publicKey } = await JWTTestHelper.createPrivyToken({
        userId: 'clabcd1234567890',
        appId: 'test-app-id',
        linkedAccounts: ['wallet:0x123'],
      });

      process.env.PRIVY_VERIFICATION_KEY = publicKey;
      process.env.ENABLE_DATA_ISOLATION = 'true';

      // 2. Initialize verifier (simulating server startup)
      const verifier = new UniversalJWTVerifier();

      expect(verifier.isEnabled()).toBe(true);
      expect(verifier.getVerificationMethod()).toBe('Ed25519');

      // 3. Server verifies token (simulating request middleware)
      const result = await verifier.verify(token);

      // 4. Verify result
      const expectedSub = 'did:privy:clabcd1234567890';
      expect(result.sub).toBe(expectedSub);
      expect(result.entityId).toBe(stringToUuid(expectedSub));
      expect(result.payload.app_id).toBe('test-app-id');

      // 5. Verify entityId is deterministic
      const result2 = await verifier.verify(token);
      expect(result2.entityId).toBe(result.entityId);
    });

    it('should enforce issuer whitelist with Privy', async () => {
      const keypair = await generateKeyPair('EdDSA');
      const publicKey = await exportSPKI(keypair.publicKey);

      process.env.PRIVY_VERIFICATION_KEY = publicKey;
      process.env.JWT_ISSUER_WHITELIST = 'https://auth.privy.io';

      const verifier = new UniversalJWTVerifier();

      // Valid issuer
      const validToken = await new SignJWT({ sub: 'user1' })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject('user1')
        .setIssuer('https://auth.privy.io')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(keypair.privateKey);

      const result = await verifier.verify(validToken);
      expect(result.sub).toBe('user1');

      // Invalid issuer
      const invalidToken = await new SignJWT({ sub: 'user2' })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject('user2')
        .setIssuer('https://malicious.com')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(keypair.privateKey);

      await expect(verifier.verify(invalidToken)).rejects.toThrow('Untrusted issuer');
    });
  });

  describe('End-to-end: Secret (Custom/Supabase) workflow', () => {
    it('should complete full authentication flow with shared secret', async () => {
      // 1. Setup: Configure shared secret
      const secret = 'test-secret-key-for-authentication-256-bits-minimum';
      process.env.JWT_SECRET = secret;
      process.env.ENABLE_DATA_ISOLATION = 'true';

      // 2. Initialize verifier
      const verifier = new UniversalJWTVerifier();

      expect(verifier.isEnabled()).toBe(true);
      expect(verifier.getVerificationMethod()).toBe('Secret');

      // 3. Client generates JWT
      const sub = 'user@example.com';
      const secretBytes = new TextEncoder().encode(secret);
      const token = await new SignJWT({
        sub,
        email: sub,
        role: 'authenticated',
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(sub)
        .setIssuer('custom-auth-server')
        .setIssuedAt()
        .setExpirationTime('2h')
        .sign(secretBytes);

      // 4. Server verifies token
      const result = await verifier.verify(token);

      // 5. Verify result
      expect(result.sub).toBe(sub);
      expect(result.entityId).toBe(stringToUuid(sub));
      expect(result.payload.role).toBe('authenticated');
    });

    it('should support Supabase HS256 legacy format', async () => {
      const supabaseSecret = 'your-super-secret-jwt-token-with-at-least-32-characters-long';
      process.env.JWT_SECRET = supabaseSecret;

      const verifier = new UniversalJWTVerifier();

      const userId = '123e4567-e89b-12d3-a456-426614174000';
      const secretBytes = new TextEncoder().encode(supabaseSecret);
      const token = await new SignJWT({
        sub: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'user@example.com',
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(userId)
        .setIssuer('https://abc123.supabase.co/auth/v1')
        .setAudience('authenticated')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secretBytes);

      const result = await verifier.verify(token);

      expect(result.sub).toBe(userId);
      expect(result.payload.aud).toBe('authenticated');
      expect(result.payload.role).toBe('authenticated');
    });
  });

  describe('Provider priority and fallback', () => {
    it('should prioritize Ed25519 over Secret when both are configured', async () => {
      const ed25519Keypair = await generateKeyPair('EdDSA');
      const ed25519PublicKey = await exportSPKI(ed25519Keypair.publicKey);

      process.env.PRIVY_VERIFICATION_KEY = ed25519PublicKey;
      process.env.JWT_SECRET = 'fallback-secret';

      const verifier = new UniversalJWTVerifier();

      // Should use Ed25519
      expect(verifier.getVerificationMethod()).toBe('Ed25519');
    });

    it('should use Secret when Ed25519 is not configured', () => {
      process.env.JWT_SECRET = 'test-secret';

      const verifier = new UniversalJWTVerifier();

      expect(verifier.getVerificationMethod()).toBe('Secret');
    });

    it('should be disabled when no configuration is provided', () => {
      // No env vars

      const verifier = new UniversalJWTVerifier();

      expect(verifier.isEnabled()).toBe(false);
      expect(verifier.getVerificationMethod()).toBe('disabled');

      // Should throw when trying to verify
      expect(() => verifier.verify('any-token')).toThrow(
        'JWT authentication is not configured'
      );
    });
  });

  describe('EntityId generation consistency', () => {
    it('should generate same entityId for same sub across different providers', async () => {
      const sub = 'user@example.com';

      // Ed25519 provider
      const ed25519Keypair = await generateKeyPair('EdDSA');
      const ed25519PublicKey = await exportSPKI(ed25519Keypair.publicKey);

      process.env.PRIVY_VERIFICATION_KEY = ed25519PublicKey;
      const ed25519Verifier = new UniversalJWTVerifier();

      const ed25519Token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(ed25519Keypair.privateKey);

      const ed25519Result = await ed25519Verifier.verify(ed25519Token);

      // Reset and configure Secret provider
      delete process.env.PRIVY_VERIFICATION_KEY;
      process.env.JWT_SECRET = 'test-secret';
      const secretVerifier = new UniversalJWTVerifier();

      const secretBytes = new TextEncoder().encode('test-secret');
      const secretToken = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secretBytes);

      const secretResult = await secretVerifier.verify(secretToken);

      // EntityIds should be identical
      expect(ed25519Result.entityId).toBe(secretResult.entityId);
      expect(ed25519Result.entityId).toBe(stringToUuid(sub));
    });

    it('should generate different entityIds for different subs', async () => {
      const secret = 'test-secret';
      process.env.JWT_SECRET = secret;
      const verifier = new UniversalJWTVerifier();

      const secretBytes = new TextEncoder().encode(secret);

      const token1 = await new SignJWT({ sub: 'user1@example.com' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('user1@example.com')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secretBytes);

      const token2 = await new SignJWT({ sub: 'user2@example.com' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('user2@example.com')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secretBytes);

      const result1 = await verifier.verify(token1);
      const result2 = await verifier.verify(token2);

      expect(result1.entityId).not.toBe(result2.entityId);
    });
  });

  describe('Data isolation scenarios', () => {
    it('should enable JWT verification when ENABLE_DATA_ISOLATION=true', async () => {
      const secret = 'test-secret';
      process.env.JWT_SECRET = secret;
      process.env.ENABLE_DATA_ISOLATION = 'true';

      const verifier = new UniversalJWTVerifier();

      expect(verifier.isEnabled()).toBe(true);
    });

    it('should work without ENABLE_DATA_ISOLATION if JWT config exists', async () => {
      const secret = 'test-secret';
      process.env.JWT_SECRET = secret;
      // ENABLE_DATA_ISOLATION not set

      const verifier = new UniversalJWTVerifier();

      expect(verifier.isEnabled()).toBe(true);

      const secretBytes = new TextEncoder().encode(secret);
      const token = await new SignJWT({ sub: 'user@example.com' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('user@example.com')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secretBytes);

      const result = await verifier.verify(token);
      expect(result.sub).toBe('user@example.com');
    });
  });

  describe('Error handling and security', () => {
    it('should reject token with missing sub claim', async () => {
      const secret = 'test-secret';
      process.env.JWT_SECRET = secret;
      const verifier = new UniversalJWTVerifier();

      const secretBytes = new TextEncoder().encode(secret);
      const token = await new SignJWT({ email: 'user@example.com' })
        .setProtectedHeader({ alg: 'HS256' })
        // No sub claim
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secretBytes);

      await expect(verifier.verify(token)).rejects.toThrow(
        'JWT missing required claim: sub'
      );
    });

    it('should reject expired tokens', async () => {
      const secret = 'test-secret';
      process.env.JWT_SECRET = secret;
      const verifier = new UniversalJWTVerifier();

      const secretBytes = new TextEncoder().encode(secret);
      const token = await new SignJWT({ sub: 'user@example.com' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('user@example.com')
        .setIssuedAt()
        .setExpirationTime('-1h') // Expired
        .sign(secretBytes);

      await expect(verifier.verify(token)).rejects.toThrow();
    });

    it('should reject tokens signed with wrong key', async () => {
      const correctSecret = 'correct-secret';
      const wrongSecret = 'wrong-secret';

      process.env.JWT_SECRET = correctSecret;
      const verifier = new UniversalJWTVerifier();

      // Sign with wrong secret
      const wrongSecretBytes = new TextEncoder().encode(wrongSecret);
      const token = await new SignJWT({ sub: 'user@example.com' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('user@example.com')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(wrongSecretBytes);

      await expect(verifier.verify(token)).rejects.toThrow();
    });

    it('should reject completely invalid tokens', async () => {
      process.env.JWT_SECRET = 'test-secret';
      const verifier = new UniversalJWTVerifier();

      await expect(verifier.verify('not.a.valid.jwt')).rejects.toThrow();
      await expect(verifier.verify('invalid-token')).rejects.toThrow();
      await expect(verifier.verify('')).rejects.toThrow();
    });
  });

  describe('Multi-tenant scenarios', () => {
    it('should support multiple Privy apps with issuer whitelist', async () => {
      const keypair = await generateKeyPair('EdDSA');
      const publicKey = await exportSPKI(keypair.publicKey);

      process.env.PRIVY_VERIFICATION_KEY = publicKey;
      process.env.JWT_ISSUER_WHITELIST = 'https://auth.privy.io';

      const verifier = new UniversalJWTVerifier();

      // App 1
      const token1 = await new SignJWT({
        sub: 'did:privy:app1-user',
        app_id: 'app-1',
      })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject('did:privy:app1-user')
        .setIssuer('https://auth.privy.io')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(keypair.privateKey);

      const result1 = await verifier.verify(token1);
      expect(result1.payload.app_id).toBe('app-1');

      // App 2 (same issuer, different app_id)
      const token2 = await new SignJWT({
        sub: 'did:privy:app2-user',
        app_id: 'app-2',
      })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject('did:privy:app2-user')
        .setIssuer('https://auth.privy.io')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(keypair.privateKey);

      const result2 = await verifier.verify(token2);
      expect(result2.payload.app_id).toBe('app-2');

      // Users have different entityIds
      expect(result1.entityId).not.toBe(result2.entityId);
    });
  });

  describe('Real-world use cases', () => {
    it('should handle typical Privy user authentication flow', async () => {
      const keypair = await generateKeyPair('EdDSA');
      const publicKey = await exportSPKI(keypair.publicKey);

      process.env.PRIVY_VERIFICATION_KEY = publicKey;

      const verifier = new UniversalJWTVerifier();

      const token = await new SignJWT({
        sub: 'did:privy:clabcd1234567890',
        app_id: 'my-app-id',
        user_id: 'user-123',
        linked_accounts: [
          'wallet:ethereum:0x1234567890abcdef',
          'email:user@example.com',
        ],
      })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject('did:privy:clabcd1234567890')
        .setIssuer('https://auth.privy.io')
        .setIssuedAt()
        .setExpirationTime('24h')
        .sign(keypair.privateKey);

      const result = await verifier.verify(token);

      expect(result.sub).toBe('did:privy:clabcd1234567890');
      expect(result.payload.linked_accounts).toContain('wallet:ethereum:0x1234567890abcdef');
      expect(result.payload.linked_accounts).toContain('email:user@example.com');
    });

    it('should handle custom authentication with role-based access', async () => {
      const secret = 'production-secret-key';
      process.env.JWT_SECRET = secret;

      const verifier = new UniversalJWTVerifier();

      const secretBytes = new TextEncoder().encode(secret);
      const adminToken = await new SignJWT({
        sub: 'admin@example.com',
        role: 'admin',
        permissions: ['read', 'write', 'delete'],
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('admin@example.com')
        .setIssuer('my-app')
        .setIssuedAt()
        .setExpirationTime('8h')
        .sign(secretBytes);

      const result = await verifier.verify(adminToken);

      expect(result.payload.role).toBe('admin');
      expect(result.payload.permissions).toContain('delete');
    });
  });
});