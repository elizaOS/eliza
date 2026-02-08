/**
 * Unit tests for SecretVerifier (HMAC-based JWT verification)
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { SecretVerifier } from '../../../../services/jwt-verifiers/secret-verifier';
import { logger, stringToUuid } from '@elizaos/core';
import { SignJWT } from 'jose';

describe('SecretVerifier', () => {
  let verifier: SecretVerifier;
  let secret: string;
  let secretBytes: Uint8Array;
  let loggerErrorSpy: ReturnType<typeof spyOn>;
  let loggerDebugSpy: ReturnType<typeof spyOn>;
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment
    process.env = { ...originalEnv };
    delete process.env.JWT_ISSUER_WHITELIST;

    // Create test secret
    secret = 'test-secret-key-for-jwt-signing-must-be-secure';
    secretBytes = new TextEncoder().encode(secret);

    // Initialize verifier
    verifier = new SecretVerifier(secret);

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
    it('should initialize with shared secret', () => {
      expect(verifier).toBeDefined();
      expect(verifier.getName()).toBe('Secret');
      expect(verifier.isConfigured()).toBe(true);
    });
  });

  describe('verify() with HS256', () => {
    it('should verify valid HS256 signed JWT token', async () => {
      const sub = 'user@example.com';
      const token = await new SignJWT({ sub, email: sub })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('test-issuer')
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('2h')
        .sign(secretBytes);

      const result = await verifier.verify(token);

      expect(result).toBeDefined();
      expect(result.sub).toBe(sub);
      expect(result.entityId).toBe(stringToUuid(sub));
      expect(result.payload.sub).toBe(sub);
      expect(result.payload.iss).toBe('test-issuer');
    });

    it('should verify valid HS384 signed JWT token', async () => {
      const sub = 'user@example.com';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'HS384' })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secretBytes);

      const result = await verifier.verify(token);
      expect(result.sub).toBe(sub);
      expect(result.entityId).toBe(stringToUuid(sub));
    });

    it('should verify valid HS512 signed JWT token', async () => {
      const sub = 'user@example.com';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'HS512' })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secretBytes);

      const result = await verifier.verify(token);
      expect(result.sub).toBe(sub);
      expect(result.entityId).toBe(stringToUuid(sub));
    });

    it('should generate deterministic entityId from sub claim', async () => {
      const sub = 'user-123';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secretBytes);

      const result1 = await verifier.verify(token);
      const result2 = await verifier.verify(token);

      // Same sub should always produce same entityId
      expect(result1.entityId).toBe(result2.entityId);
      expect(result1.entityId).toBe(stringToUuid(sub));
    });

    it('should reject token without sub claim', async () => {
      const token = await new SignJWT({ email: 'test@example.com' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secretBytes);

      await expect(verifier.verify(token)).rejects.toThrow(
        'JWT missing required claim: sub'
      );
      // Structured logging: logger.error({ src, error }, 'message')
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ src: 'http' }),
        'Secret JWT verification failed'
      );
    });

    it('should reject expired token', async () => {
      const sub = 'user@example.com';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('-1h') // Expired 1 hour ago
        .sign(secretBytes);

      await expect(verifier.verify(token)).rejects.toThrow();
      expect(loggerErrorSpy).toHaveBeenCalled();
    });

    it('should reject token signed with wrong secret', async () => {
      const wrongSecret = new TextEncoder().encode('wrong-secret-key');

      const sub = 'user@example.com';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(wrongSecret); // Sign with different secret

      await expect(verifier.verify(token)).rejects.toThrow();
      // Structured logging: logger.error({ src, error }, 'message')
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ src: 'http' }),
        'Secret JWT verification failed'
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
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(sub)
        .setIssuer('test-issuer')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secretBytes);

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
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(sub)
        .setIssuer('any-issuer')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secretBytes);

      const result = await verifier.verify(token);
      expect(result.sub).toBe(sub);
    });

    it('should allow any issuer when whitelist is "*"', async () => {
      process.env.JWT_ISSUER_WHITELIST = '*';

      const sub = 'user@example.com';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(sub)
        .setIssuer('any-random-issuer')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secretBytes);

      const result = await verifier.verify(token);
      expect(result.sub).toBe(sub);
    });

    it('should allow token from whitelisted issuer', async () => {
      process.env.JWT_ISSUER_WHITELIST = 'custom-issuer-1,custom-issuer-2';

      const sub = 'user@example.com';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(sub)
        .setIssuer('custom-issuer-1')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secretBytes);

      const result = await verifier.verify(token);
      expect(result.sub).toBe(sub);
    });

    it('should reject token from non-whitelisted issuer', async () => {
      process.env.JWT_ISSUER_WHITELIST = 'custom-issuer-1,custom-issuer-2';

      const sub = 'user@example.com';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(sub)
        .setIssuer('malicious-issuer')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secretBytes);

      await expect(verifier.verify(token)).rejects.toThrow('Untrusted issuer');
      // Structured logging: logger.error({ src, error }, 'message')
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ src: 'http' }),
        'Secret JWT verification failed'
      );
    });
  });

  describe('getName()', () => {
    it('should return "Secret"', () => {
      expect(verifier.getName()).toBe('Secret');
    });
  });

  describe('isConfigured()', () => {
    it('should return true when secret is provided', () => {
      expect(verifier.isConfigured()).toBe(true);
    });

    // Note: Empty string creates empty Uint8Array which is truthy
    // The verifier will fail when verify() is called with empty secret
  });

  describe('Supabase-specific scenarios (legacy HS256)', () => {
    it('should verify Supabase JWT format with UUID sub', async () => {
      const supabaseUserId = '123e4567-e89b-12d3-a456-426614174000';
      const supabaseSecret = 'your-super-secret-jwt-token-with-at-least-32-characters-long';
      const supabaseSecretBytes = new TextEncoder().encode(supabaseSecret);

      const supabaseVerifier = new SecretVerifier(supabaseSecret);

      const token = await new SignJWT({
        sub: supabaseUserId,
        aud: 'authenticated',
        role: 'authenticated',
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(supabaseUserId)
        .setIssuer('https://abc123.supabase.co/auth/v1')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(supabaseSecretBytes);

      const result = await supabaseVerifier.verify(token);

      expect(result.sub).toBe(supabaseUserId);
      expect(result.payload.aud).toBe('authenticated');
      expect(result.payload.role).toBe('authenticated');
    });
  });

  describe('Error handling', () => {
    it('should provide descriptive error for invalid signature', async () => {
      const sub = 'user@example.com';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secretBytes);

      // Tamper with token
      const tamperedToken = token.slice(0, -10) + 'tampered123';

      await expect(verifier.verify(tamperedToken)).rejects.toThrow(
        'JWT verification failed'
      );
    });
  });
});
