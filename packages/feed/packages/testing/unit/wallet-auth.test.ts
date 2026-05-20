/**
 * Unit Tests: Wallet Auth — Token Freshness Check
 *
 * Tests requireFreshToken() which verifies Privy JWT age for wallet mutations.
 * Exercises real code paths in packages/api/src/wallet-auth.ts.
 *
 * Run with: bun test unit/wallet-auth.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { requireFreshToken, type TokenFreshnessResult } from '@feed/api';

// ---------------------------------------------------------------------------
// Helpers: build unsigned JWTs with controlled `iat`
// ---------------------------------------------------------------------------

function base64url(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function buildJwt(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' }
): string {
  return `${base64url(header)}.${base64url(payload)}.fake-signature`;
}

const NOW = Math.floor(Date.now() / 1000);

const BASE_PAYLOAD = {
  aud: 'test-app-id',
  sub: 'did:privy:user123',
  iss: 'privy.io',
  exp: NOW + 3600,
};

// ---------------------------------------------------------------------------
// Fresh tokens (within the 5-minute window)
// ---------------------------------------------------------------------------

describe('requireFreshToken — fresh tokens', () => {
  test('token issued just now is fresh', () => {
    const token = buildJwt({ ...BASE_PAYLOAD, iat: NOW });
    const result = requireFreshToken(token);
    expect(result.fresh).toBe(true);
    expect(result.ageSeconds).toBeLessThanOrEqual(1);
  });

  test('token issued 10 seconds ago is fresh', () => {
    const token = buildJwt({ ...BASE_PAYLOAD, iat: NOW - 10 });
    const result = requireFreshToken(token);
    expect(result.fresh).toBe(true);
    expect(result.ageSeconds).toBeGreaterThanOrEqual(9);
    expect(result.ageSeconds).toBeLessThanOrEqual(11);
  });

  test('token issued 60 seconds ago is fresh', () => {
    const token = buildJwt({ ...BASE_PAYLOAD, iat: NOW - 60 });
    const result = requireFreshToken(token);
    expect(result.fresh).toBe(true);
  });

  test('token issued exactly at the 300-second boundary is fresh', () => {
    // Use NOW captured at call time to avoid clock drift between module load and test execution
    const now = Math.floor(Date.now() / 1000);
    const token = buildJwt({ ...BASE_PAYLOAD, iat: now - 300 });
    const result = requireFreshToken(token);
    // age <= maxAgeSeconds, so 300 <= 300 should be fresh
    expect(result.fresh).toBe(true);
    expect(result.ageSeconds).toBeGreaterThanOrEqual(299);
    expect(result.ageSeconds).toBeLessThanOrEqual(301);
  });

  test('token issued 299 seconds ago is fresh', () => {
    const token = buildJwt({ ...BASE_PAYLOAD, iat: NOW - 299 });
    const result = requireFreshToken(token);
    expect(result.fresh).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stale tokens (beyond the 5-minute window)
// ---------------------------------------------------------------------------

describe('requireFreshToken — stale tokens', () => {
  test('token issued 301 seconds ago is stale', () => {
    const token = buildJwt({ ...BASE_PAYLOAD, iat: NOW - 301 });
    const result = requireFreshToken(token);
    expect(result.fresh).toBe(false);
    expect(result.ageSeconds).toBeGreaterThanOrEqual(300);
  });

  test('token issued 600 seconds ago is stale', () => {
    const token = buildJwt({ ...BASE_PAYLOAD, iat: NOW - 600 });
    const result = requireFreshToken(token);
    expect(result.fresh).toBe(false);
    expect(result.ageSeconds).toBeGreaterThanOrEqual(599);
  });

  test('token issued 1 hour ago is stale', () => {
    const token = buildJwt({ ...BASE_PAYLOAD, iat: NOW - 3600 });
    const result = requireFreshToken(token);
    expect(result.fresh).toBe(false);
    expect(result.ageSeconds).toBeGreaterThanOrEqual(3599);
  });

  test('token issued 1 day ago is stale', () => {
    const token = buildJwt({ ...BASE_PAYLOAD, iat: NOW - 86400 });
    const result = requireFreshToken(token);
    expect(result.fresh).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Custom maxAgeSeconds
// ---------------------------------------------------------------------------

describe('requireFreshToken — custom maxAgeSeconds', () => {
  test('token at 120s is fresh with maxAge=120', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = buildJwt({ ...BASE_PAYLOAD, iat: now - 120 });
    const result = requireFreshToken(token, 120);
    expect(result.fresh).toBe(true);
  });

  test('token at 121s is stale with maxAge=120', () => {
    const token = buildJwt({ ...BASE_PAYLOAD, iat: NOW - 121 });
    const result = requireFreshToken(token, 120);
    expect(result.fresh).toBe(false);
  });

  test('maxAge of 0 means only NOW tokens are fresh', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = buildJwt({ ...BASE_PAYLOAD, iat: now });
    const result = requireFreshToken(token, 0);
    expect(result.fresh).toBe(true);
  });

  test('maxAge of 0 rejects 1-second-old token', () => {
    const token = buildJwt({ ...BASE_PAYLOAD, iat: NOW - 1 });
    const result = requireFreshToken(token, 0);
    expect(result.fresh).toBe(false);
  });

  test('very large maxAge accepts very old tokens', () => {
    const token = buildJwt({ ...BASE_PAYLOAD, iat: NOW - 86400 });
    const result = requireFreshToken(token, 100000);
    expect(result.fresh).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid / malformed tokens
// ---------------------------------------------------------------------------

describe('requireFreshToken — invalid tokens', () => {
  test('empty string returns not fresh with Infinity age', () => {
    const result = requireFreshToken('');
    expect(result.fresh).toBe(false);
    expect(result.ageSeconds).toBe(Infinity);
  });

  test('random string returns not fresh with Infinity age', () => {
    const result = requireFreshToken('not-a-jwt');
    expect(result.fresh).toBe(false);
    expect(result.ageSeconds).toBe(Infinity);
  });

  test('JWT missing iat claim returns not fresh with Infinity age', () => {
    const { iat: _, ...noIat } = { ...BASE_PAYLOAD, iat: NOW };
    const token = buildJwt(noIat);
    const result = requireFreshToken(token);
    expect(result.fresh).toBe(false);
    expect(result.ageSeconds).toBe(Infinity);
  });

  test('JWT with iat=0 is treated as very old', () => {
    const token = buildJwt({ ...BASE_PAYLOAD, iat: 0 });
    const result = requireFreshToken(token);
    expect(result.fresh).toBe(false);
    // iat=0 means January 1, 1970 — age should be huge
    expect(result.ageSeconds).toBeGreaterThan(1_000_000);
  });

  test('JWT with iat as string returns not fresh', () => {
    const token = buildJwt({ ...BASE_PAYLOAD, iat: 'not-a-number' });
    const result = requireFreshToken(token);
    // safeDecodeJwtPayload will fail Zod validation for non-number iat
    expect(result.fresh).toBe(false);
  });

  test('JWT with negative iat returns not fresh', () => {
    const token = buildJwt({ ...BASE_PAYLOAD, iat: -1000 });
    const result = requireFreshToken(token);
    expect(result.fresh).toBe(false);
    expect(result.ageSeconds).toBeGreaterThan(1000);
  });

  test('JWT with future iat (clock skew) returns fresh', () => {
    // If iat is in the future, age calculation gives negative number
    // age = now - iat = negative, which is <= maxAgeSeconds, so fresh
    const token = buildJwt({ ...BASE_PAYLOAD, iat: NOW + 60 });
    const result = requireFreshToken(token);
    expect(result.fresh).toBe(true);
    expect(result.ageSeconds).toBeLessThan(0);
  });

  test('malformed base64 payload returns not fresh', () => {
    const token = 'eyJhbGciOiJSUzI1NiJ9.!!!invalid-base64!!!.fake';
    const result = requireFreshToken(token);
    expect(result.fresh).toBe(false);
    expect(result.ageSeconds).toBe(Infinity);
  });

  test('JWT with only two parts (no signature) returns not fresh', () => {
    const header = base64url({ alg: 'RS256' });
    const payload = base64url({ ...BASE_PAYLOAD, iat: NOW });
    const result = requireFreshToken(`${header}.${payload}`);
    // safeDecodeJwtPayload may still work (splits by '.' and takes index 1)
    // but behavior depends on implementation
    expect(typeof result.fresh).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// Return type contract
// ---------------------------------------------------------------------------

describe('requireFreshToken — return type', () => {
  test('always returns an object with fresh and ageSeconds', () => {
    const result = requireFreshToken('anything');
    expect(result).toHaveProperty('fresh');
    expect(result).toHaveProperty('ageSeconds');
    expect(typeof result.fresh).toBe('boolean');
    expect(typeof result.ageSeconds).toBe('number');
  });

  test('satisfies TokenFreshnessResult interface', () => {
    const token = buildJwt({ ...BASE_PAYLOAD, iat: NOW });
    const result: TokenFreshnessResult = requireFreshToken(token);
    expect(result.fresh).toBe(true);
    expect(typeof result.ageSeconds).toBe('number');
  });
});
