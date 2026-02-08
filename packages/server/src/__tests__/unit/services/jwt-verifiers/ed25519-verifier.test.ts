/**
 * Unit tests for Ed25519Verifier (Privy and other Ed25519 providers)
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Ed25519Verifier } from '../../../../services/jwt-verifiers/ed25519-verifier';
import { logger, stringToUuid } from '@elizaos/core';
import { SignJWT, generateKeyPair, exportSPKI } from 'jose';

describe('Ed25519Verifier', () => {
  let verifier: Ed25519Verifier;
  let publicKey: string;
  let privateKey: any;
  let loggerErrorSpy: ReturnType<typeof spyOn>;
  let loggerDebugSpy: ReturnType<typeof spyOn>;
  const originalEnv = process.env;

  beforeEach(async () => {
    // Reset environment
    process.env = { ...originalEnv };
    delete process.env.JWT_ISSUER_WHITELIST;

    // Generate Ed25519 keypair for testing
    const keypair = await generateKeyPair('EdDSA');
    privateKey = keypair.privateKey;
    publicKey = await exportSPKI(keypair.publicKey);

    // Initialize verifier with public key
    verifier = new Ed25519Verifier(publicKey);

    // Spy on logger methods
    loggerErrorSpy = spyOn(logger, 'error');
    loggerDebugSpy = spyOn(logger, 'debug');
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    loggerErrorSpy?.mockRestore();
    loggerDebugSpy?.mockRestore();
  });

  describe('Constructor', () => {
    it('should initialize with Ed25519 public key', () => {
      expect(verifier).toBeDefined();
      expect(verifier.getName()).toBe('Ed25519');
      expect(verifier.isConfigured()).toBe(true);
    });
  });

  describe('verify()', () => {
    it('should verify valid Ed25519 signed JWT token', async () => {
      const sub = 'user@example.com';
      const token = await new SignJWT({ sub, email: sub })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setIssuer('test-issuer')
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('2h')
        .sign(privateKey);

      const result = await verifier.verify(token);

      expect(result).toBeDefined();
      expect(result.sub).toBe(sub);
      expect(result.entityId).toBe(stringToUuid(sub));
      expect(result.payload.sub).toBe(sub);
      expect(result.payload.iss).toBe('test-issuer');
    });

    it('should generate deterministic entityId from sub claim', async () => {
      const sub = 'did:privy:123456';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const result1 = await verifier.verify(token);
      const result2 = await verifier.verify(token);

      // Same sub should always produce same entityId
      expect(result1.entityId).toBe(result2.entityId);
      expect(result1.entityId).toBe(stringToUuid(sub));
    });

    it('should reject token without sub claim', async () => {
      const token = await new SignJWT({ email: 'test@example.com' })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      await expect(verifier.verify(token)).rejects.toThrow(
        'JWT missing required claim: sub'
      );
      // Structured logging: logger.error({ src, error }, 'message')
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ src: 'http' }),
        'Ed25519 JWT verification failed'
      );
    });

    it('should reject expired token', async () => {
      const sub = 'user@example.com';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('-1h') // Expired 1 hour ago
        .sign(privateKey);

      await expect(verifier.verify(token)).rejects.toThrow();
      expect(loggerErrorSpy).toHaveBeenCalled();
    });

    it('should reject token signed with wrong key', async () => {
      // Generate different keypair
      const wrongKeypair = await generateKeyPair('EdDSA');

      const sub = 'user@example.com';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(wrongKeypair.privateKey); // Sign with different key

      await expect(verifier.verify(token)).rejects.toThrow();
      // Structured logging: logger.error({ src, error }, 'message')
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ src: 'http' }),
        'Ed25519 JWT verification failed'
      );
    });

    it('should reject malformed token', async () => {
      const malformedToken = 'not.a.valid.jwt';

      await expect(verifier.verify(malformedToken)).rejects.toThrow();
      expect(loggerErrorSpy).toHaveBeenCalled();
    });

    it('should include full payload in result', async () => {
      const sub = 'user@example.com';
      const customData = { role: 'admin', permissions: ['read', 'write'] };

      const token = await new SignJWT({ sub, ...customData })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject(sub)
        .setIssuer('test-issuer')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const result = await verifier.verify(token);

      expect(result.payload.sub).toBe(sub);
      expect(result.payload.iss).toBe('test-issuer');
      expect(result.payload.role).toBe('admin');
      expect(result.payload.permissions).toEqual(['read', 'write']);
    });
  });

  describe('Issuer Whitelist', () => {
    it('should allow token when no whitelist is configured', async () => {
      delete process.env.JWT_ISSUER_WHITELIST;

      const sub = 'user@example.com';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject(sub)
        .setIssuer('any-issuer')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const result = await verifier.verify(token);
      expect(result.sub).toBe(sub);
    });

    it('should allow any issuer when whitelist is "*"', async () => {
      process.env.JWT_ISSUER_WHITELIST = '*';

      const sub = 'user@example.com';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject(sub)
        .setIssuer('any-random-issuer')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const result = await verifier.verify(token);
      expect(result.sub).toBe(sub);
    });

    it('should allow token from whitelisted issuer', async () => {
      process.env.JWT_ISSUER_WHITELIST = 'https://auth.privy.io,https://clerk.example.com';

      const sub = 'user@example.com';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject(sub)
        .setIssuer('https://auth.privy.io')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const result = await verifier.verify(token);
      expect(result.sub).toBe(sub);
    });

    it('should reject token from non-whitelisted issuer', async () => {
      process.env.JWT_ISSUER_WHITELIST = 'https://auth.privy.io,https://clerk.example.com';

      const sub = 'user@example.com';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject(sub)
        .setIssuer('https://malicious-issuer.com')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      await expect(verifier.verify(token)).rejects.toThrow('Untrusted issuer');
      // Structured logging: logger.error({ src, error }, 'message')
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ src: 'http' }),
        'Ed25519 JWT verification failed'
      );
    });
  });

  describe('getName()', () => {
    it('should return "Ed25519"', () => {
      expect(verifier.getName()).toBe('Ed25519');
    });
  });

  describe('isConfigured()', () => {
    it('should return true when verification key is provided', () => {
      expect(verifier.isConfigured()).toBe(true);
    });

    // Note: importSPKI throws asynchronously, so we can't test synchronous throw
    // The verifier will fail when verify() is called with invalid key
  });

  describe('Privy-specific scenarios', () => {
    it('should verify Privy DID format (did:privy:...)', async () => {
      const privyDid = 'did:privy:clabcd1234567890';
      const token = await new SignJWT({ sub: privyDid })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject(privyDid)
        .setIssuer('https://auth.privy.io')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const result = await verifier.verify(token);

      expect(result.sub).toBe(privyDid);
      expect(result.entityId).toBe(stringToUuid(privyDid));
    });

    it('should handle Privy custom claims', async () => {
      const sub = 'did:privy:test123';
      const token = await new SignJWT({
        sub,
        // Privy-specific claims
        app_id: 'test-app-id',
        user_id: 'user-123',
        linked_accounts: ['wallet:0x123', 'email:test@example.com'],
      })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject(sub)
        .setIssuer('https://auth.privy.io')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const result = await verifier.verify(token);

      expect(result.payload.app_id).toBe('test-app-id');
      expect(result.payload.user_id).toBe('user-123');
      expect(result.payload.linked_accounts).toContain('wallet:0x123');
    });
  });

  describe('Error handling', () => {
    it('should provide descriptive error for invalid signature', async () => {
      const sub = 'user@example.com';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      // Tamper with token by appending characters
      const tamperedToken = token + 'xyz';

      await expect(verifier.verify(tamperedToken)).rejects.toThrow(
        'Ed25519 JWT verification failed'
      );
    });
  });
});
