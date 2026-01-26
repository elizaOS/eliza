/**
 * Unit tests for JWKSVerifier (Auth0, Clerk, Supabase, Google, etc.)
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, spyOn, jest } from 'bun:test';
import { JWKSVerifier } from '../../../../services/jwt-verifiers/jwks-verifier';
import { logger, stringToUuid } from '@elizaos/core';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';

describe('JWKSVerifier', () => {
  let verifier: JWKSVerifier;
  let jwksUri: string;
  let privateKey: any;
  let publicJwk: any;
  let loggerErrorSpy: ReturnType<typeof spyOn>;
  let loggerDebugSpy: ReturnType<typeof spyOn>;
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;

  // Helper to create mock fetch response
  const createMockFetch = (jwks: { keys: any[] }) => {
    return jest.fn((url: string) => {
      if (url.includes('.well-known/jwks.json') || url.includes('/certs')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(jwks),
        } as Response);
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
  };

  beforeAll(async () => {
    // Generate RS256 keypair for testing (common for Auth0, Clerk, etc.)
    const keypair = await generateKeyPair('RS256');
    privateKey = keypair.privateKey;
    publicJwk = await exportJWK(keypair.publicKey);
    publicJwk.kid = 'test-key-id-1';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.JWT_ISSUER_WHITELIST;

    jwksUri = 'https://test-provider.com/.well-known/jwks.json';

    // Mock fetch to return our public key
    globalThis.fetch = createMockFetch({ keys: [publicJwk] }) as any;

    verifier = new JWKSVerifier(jwksUri);

    loggerErrorSpy = spyOn(logger, 'error');
    loggerDebugSpy = spyOn(logger, 'debug');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    loggerErrorSpy?.mockRestore();
    loggerDebugSpy?.mockRestore();
  });

  describe('Constructor', () => {
    it('should initialize with JWKS URI', () => {
      expect(verifier).toBeDefined();
      expect(verifier.getName()).toBe('JWKS');
      expect(verifier.isConfigured()).toBe(true);
    });

    it('should accept various JWKS URI formats', () => {
      const auth0Verifier = new JWKSVerifier('https://tenant.auth0.com/.well-known/jwks.json');
      expect(auth0Verifier.isConfigured()).toBe(true);

      const clerkVerifier = new JWKSVerifier('https://clerk.example.com/.well-known/jwks.json');
      expect(clerkVerifier.isConfigured()).toBe(true);

      const googleVerifier = new JWKSVerifier('https://www.googleapis.com/oauth2/v3/certs');
      expect(googleVerifier.isConfigured()).toBe(true);
    });
  });

  describe('verify() with RS256', () => {
    it('should verify valid RS256 signed JWT token', async () => {
      const sub = 'user@example.com';
      const token = await new SignJWT({ sub, email: sub })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-id-1' })
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
      // No debug log in implementation - just returns result
    });

    it('should generate deterministic entityId from sub claim', async () => {
      const sub = 'auth0|123456';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-id-1' })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const result1 = await verifier.verify(token);
      const result2 = await verifier.verify(token);

      expect(result1.entityId).toBe(result2.entityId);
      expect(result1.entityId).toBe(stringToUuid(sub));
    });

    it('should reject token without sub claim', async () => {
      const token = await new SignJWT({ email: 'test@example.com' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-id-1' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      await expect(verifier.verify(token)).rejects.toThrow(
        'JWT missing required claim: sub'
      );
      // Structured logging: logger.error({ src, error }, 'message')
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ src: 'http' }),
        'JWKS JWT verification failed'
      );
    });

    it('should reject expired token', async () => {
      const sub = 'user@example.com';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-id-1' })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('-1h')
        .sign(privateKey);

      await expect(verifier.verify(token)).rejects.toThrow();
      expect(loggerErrorSpy).toHaveBeenCalled();
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
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-id-1' })
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
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-id-1' })
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
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-id-1' })
        .setSubject(sub)
        .setIssuer('any-random-issuer')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const result = await verifier.verify(token);
      expect(result.sub).toBe(sub);
    });

    it('should allow token from whitelisted issuer', async () => {
      process.env.JWT_ISSUER_WHITELIST = 'https://tenant.auth0.com/,https://clerk.example.com';

      const sub = 'user@example.com';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-id-1' })
        .setSubject(sub)
        .setIssuer('https://tenant.auth0.com/')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const result = await verifier.verify(token);
      expect(result.sub).toBe(sub);
    });

    it('should reject token from non-whitelisted issuer', async () => {
      process.env.JWT_ISSUER_WHITELIST = 'https://tenant.auth0.com/,https://clerk.example.com';

      const sub = 'user@example.com';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-id-1' })
        .setSubject(sub)
        .setIssuer('https://malicious-issuer.com')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      await expect(verifier.verify(token)).rejects.toThrow('Untrusted issuer');
      // Structured logging: logger.error({ src, error }, 'message')
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ src: 'http' }),
        'JWKS JWT verification failed'
      );
    });
  });

  describe('getName()', () => {
    it('should return "JWKS"', () => {
      expect(verifier.getName()).toBe('JWKS');
    });
  });

  describe('isConfigured()', () => {
    it('should return true when JWKS URI is provided', () => {
      expect(verifier.isConfigured()).toBe(true);
    });
  });

  describe('Provider-specific scenarios', () => {
    it('should verify Auth0 JWT format', async () => {
      const auth0Sub = 'auth0|1234567890';
      const token = await new SignJWT({
        sub: auth0Sub,
        aud: 'https://api.example.com',
        azp: 'client-id-123',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-id-1' })
        .setSubject(auth0Sub)
        .setIssuer('https://tenant.auth0.com/')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const result = await verifier.verify(token);

      expect(result.sub).toBe(auth0Sub);
      expect(result.payload.aud).toBe('https://api.example.com');
      expect(result.payload.azp).toBe('client-id-123');
    });

    it('should verify Clerk JWT format', async () => {
      const clerkSub = 'user_2abcdefgh123456';
      const token = await new SignJWT({
        sub: clerkSub,
        azp: 'https://app.example.com',
        session_id: 'sess_xyz',
        org_id: 'org_abc',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-id-1' })
        .setSubject(clerkSub)
        .setIssuer('https://clerk.example.com')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const result = await verifier.verify(token);

      expect(result.sub).toBe(clerkSub);
      expect(result.payload.session_id).toBe('sess_xyz');
      expect(result.payload.org_id).toBe('org_abc');
    });

    it('should verify Google JWT format', async () => {
      const googleSub = '1234567890';
      const token = await new SignJWT({
        sub: googleSub,
        email: 'user@gmail.com',
        email_verified: true,
        azp: 'client-id.apps.googleusercontent.com',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-id-1' })
        .setSubject(googleSub)
        .setIssuer('https://accounts.google.com')
        .setAudience('client-id.apps.googleusercontent.com')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const result = await verifier.verify(token);

      expect(result.sub).toBe(googleSub);
      expect(result.payload.email).toBe('user@gmail.com');
      expect(result.payload.email_verified).toBe(true);
    });

    it('should verify Supabase JWT format (asymmetric keys)', async () => {
      const supabaseSub = '123e4567-e89b-12d3-a456-426614174000';
      const token = await new SignJWT({
        sub: supabaseSub,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'user@example.com',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-id-1' })
        .setSubject(supabaseSub)
        .setIssuer('https://abc123.supabase.co/auth/v1')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const result = await verifier.verify(token);

      expect(result.sub).toBe(supabaseSub);
      expect(result.payload.role).toBe('authenticated');
      expect(result.payload.email).toBe('user@example.com');
    });
  });

  describe('Error handling', () => {
    it('should provide descriptive error for invalid signature', async () => {
      const wrongKeypair = await generateKeyPair('RS256');

      const sub = 'user@example.com';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-id-1' })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(wrongKeypair.privateKey);

      await expect(verifier.verify(token)).rejects.toThrow();
      expect(loggerErrorSpy).toHaveBeenCalled();
    });

    it('should handle missing kid in token header', async () => {
      const sub = 'user@example.com';
      const token = await new SignJWT({ sub })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

      const result = await verifier.verify(token);
      expect(result.sub).toBe(sub);
    });
  });
});
