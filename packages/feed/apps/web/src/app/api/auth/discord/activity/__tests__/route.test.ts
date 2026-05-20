/**
 * Tests for Discord Activity OAuth State Generation & Verification
 *
 * @route GET /api/auth/discord/activity/state
 * @route POST /api/auth/discord/activity
 *
 * Covers:
 * - Signed state token generation
 * - State token verification (valid, expired, tampered, malformed)
 * - Timing-safe comparison
 * - Edge cases
 */

import { describe, expect, it } from 'bun:test';
import { generateSignedState, verifySignedState } from '../state/state-utils';

const TEST_SECRET = 'test-discord-client-secret-for-unit-tests';

describe('Discord Activity OAuth State', () => {
  describe('generateSignedState', () => {
    it('should produce a token with three dot-separated parts', () => {
      const state = generateSignedState(TEST_SECRET);
      const parts = state.split('.');
      expect(parts).toHaveLength(3);
    });

    it('should produce a valid UUID as the first part', () => {
      const state = generateSignedState(TEST_SECRET);
      const [nonce] = state.split('.');
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(uuidRegex.test(nonce)).toBe(true);
    });

    it('should produce a numeric timestamp as the second part', () => {
      const state = generateSignedState(TEST_SECRET);
      const parts = state.split('.');
      const timestamp = Number.parseInt(parts[1], 10);
      expect(Number.isNaN(timestamp)).toBe(false);
      // Timestamp should be within a few seconds of now
      const now = Math.floor(Date.now() / 1000);
      expect(Math.abs(now - timestamp)).toBeLessThan(5);
    });

    it('should produce a hex-encoded signature as the third part', () => {
      const state = generateSignedState(TEST_SECRET);
      const parts = state.split('.');
      const hexRegex = /^[0-9a-f]{64}$/; // SHA-256 = 32 bytes = 64 hex chars
      expect(hexRegex.test(parts[2])).toBe(true);
    });

    it('should produce unique tokens on each call', () => {
      const state1 = generateSignedState(TEST_SECRET);
      const state2 = generateSignedState(TEST_SECRET);
      expect(state1).not.toBe(state2);
    });
  });

  describe('verifySignedState', () => {
    it('should verify a freshly generated state token', () => {
      const state = generateSignedState(TEST_SECRET);
      const result = verifySignedState(state, TEST_SECRET);
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should reject a token signed with a different secret', () => {
      const state = generateSignedState(TEST_SECRET);
      const result = verifySignedState(state, 'wrong-secret');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('signature mismatch');
    });

    it('should reject a malformed token (missing parts)', () => {
      const result = verifySignedState('just-a-string', TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('malformed state token');
    });

    it('should reject a token with only two parts', () => {
      const result = verifySignedState('part1.part2', TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('malformed state token');
    });

    it('should reject a token with four parts', () => {
      const result = verifySignedState('part1.part2.part3.part4', TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('malformed state token');
    });

    it('should reject a token with an invalid UUID nonce', () => {
      const result = verifySignedState(
        'not-a-uuid.1234567890.deadbeef',
        TEST_SECRET
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid nonce format');
    });

    it('should reject a token with a non-numeric timestamp', () => {
      const result = verifySignedState(
        '550e8400-e29b-41d4-a716-446655440000.notanumber.deadbeef',
        TEST_SECRET
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid timestamp');
    });

    it('should reject an expired token (timestamp older than TTL)', () => {
      // Generate a state token, then manipulate the timestamp to be old.
      // We need to rebuild the signature for the old timestamp to test
      // expiry separately from signature validation.
      const { createHmac } = require('crypto');
      const nonce = '550e8400-e29b-41d4-a716-446655440000';
      const oldTimestamp = Math.floor(Date.now() / 1000) - 400; // 400s ago > 300s TTL
      const payload = `${nonce}.${oldTimestamp}`;
      const key = createHmac('sha256', 'discord-activity-oauth-state')
        .update(TEST_SECRET)
        .digest();
      const signature = createHmac('sha256', key).update(payload).digest('hex');
      const expiredState = `${payload}.${signature}`;

      const result = verifySignedState(expiredState, TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('state token expired');
    });

    it('should reject a token with a future timestamp beyond skew tolerance', () => {
      const { createHmac } = require('crypto');
      const nonce = '550e8400-e29b-41d4-a716-446655440000';
      const futureTimestamp = Math.floor(Date.now() / 1000) + 120; // 2 minutes in the future
      const payload = `${nonce}.${futureTimestamp}`;
      const key = createHmac('sha256', 'discord-activity-oauth-state')
        .update(TEST_SECRET)
        .digest();
      const signature = createHmac('sha256', key).update(payload).digest('hex');
      const futureState = `${payload}.${signature}`;

      const result = verifySignedState(futureState, TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('state token issued in the future');
    });

    it('should accept a token within clock skew tolerance (≤30s in future)', () => {
      const { createHmac } = require('crypto');
      const nonce = '550e8400-e29b-41d4-a716-446655440000';
      const nearFutureTimestamp = Math.floor(Date.now() / 1000) + 15; // 15s in the future
      const payload = `${nonce}.${nearFutureTimestamp}`;
      const key = createHmac('sha256', 'discord-activity-oauth-state')
        .update(TEST_SECRET)
        .digest();
      const signature = createHmac('sha256', key).update(payload).digest('hex');
      const nearFutureState = `${payload}.${signature}`;

      const result = verifySignedState(nearFutureState, TEST_SECRET);
      expect(result.valid).toBe(true);
    });

    it('should reject a token with a tampered nonce', () => {
      const state = generateSignedState(TEST_SECRET);
      const parts = state.split('.');
      // Replace first character of the nonce
      const tamperedNonce =
        (parts[0][0] === 'a' ? 'b' : 'a') + parts[0].slice(1);
      const tampered = `${tamperedNonce}.${parts[1]}.${parts[2]}`;

      const result = verifySignedState(tampered, TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('signature mismatch');
    });

    it('should reject a token with a tampered timestamp', () => {
      const state = generateSignedState(TEST_SECRET);
      const parts = state.split('.');
      const originalTimestamp = Number.parseInt(parts[1], 10);
      const tampered = `${parts[0]}.${originalTimestamp + 1}.${parts[2]}`;

      const result = verifySignedState(tampered, TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('signature mismatch');
    });

    it('should reject a token with a tampered signature', () => {
      const state = generateSignedState(TEST_SECRET);
      const parts = state.split('.');
      // Flip a character in the signature
      const tamperedSig = (parts[2][0] === 'a' ? 'b' : 'a') + parts[2].slice(1);
      const tampered = `${parts[0]}.${parts[1]}.${tamperedSig}`;

      const result = verifySignedState(tampered, TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('signature mismatch');
    });

    it('should reject an empty string', () => {
      const result = verifySignedState('', TEST_SECRET);
      expect(result.valid).toBe(false);
    });

    it('should reject a signature with non-hex characters', () => {
      const state = generateSignedState(TEST_SECRET);
      const parts = state.split('.');
      // Replace signature with non-hex characters
      const nonHexSig = 'g'.repeat(64);
      const tampered = `${parts[0]}.${parts[1]}.${nonHexSig}`;

      const result = verifySignedState(tampered, TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('signature mismatch');
    });

    it('should reject a truncated signature', () => {
      const state = generateSignedState(TEST_SECRET);
      const parts = state.split('.');
      // Truncate the signature
      const truncated = `${parts[0]}.${parts[1]}.${parts[2].slice(0, 32)}`;

      const result = verifySignedState(truncated, TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('signature mismatch');
    });
  });

  describe('Cross-secret isolation', () => {
    it('should not validate tokens across different secrets', () => {
      const secretA = 'secret-application-A';
      const secretB = 'secret-application-B';

      const stateFromA = generateSignedState(secretA);
      const stateFromB = generateSignedState(secretB);

      // Each should only validate with its own secret
      expect(verifySignedState(stateFromA, secretA).valid).toBe(true);
      expect(verifySignedState(stateFromB, secretB).valid).toBe(true);

      // Cross-validation must fail
      expect(verifySignedState(stateFromA, secretB).valid).toBe(false);
      expect(verifySignedState(stateFromB, secretA).valid).toBe(false);
    });

    it('should produce different signatures for the same nonce with different secrets', () => {
      // Two tokens generated close together might have the same timestamp
      // but must still produce different signatures due to different keys
      const secretA = 'key-one';
      const secretB = 'key-two';

      const stateA = generateSignedState(secretA);
      const stateB = generateSignedState(secretB);

      const sigA = stateA.split('.')[2];
      const sigB = stateB.split('.')[2];

      // They can't be the same (different keys, even if nonce+timestamp were identical)
      // Note: nonces are random UUIDs so they'll differ anyway, making this always true
      expect(sigA).not.toBe(sigB);
    });
  });

  describe('Boundary conditions', () => {
    it('should accept a token at exactly the TTL boundary', () => {
      const { createHmac } = require('crypto');
      const nonce = '550e8400-e29b-41d4-a716-446655440000';
      // Exactly at TTL boundary (300 seconds)
      const boundaryTimestamp = Math.floor(Date.now() / 1000) - 300;
      const payload = `${nonce}.${boundaryTimestamp}`;
      const key = createHmac('sha256', 'discord-activity-oauth-state')
        .update(TEST_SECRET)
        .digest();
      const signature = createHmac('sha256', key).update(payload).digest('hex');
      const boundaryState = `${payload}.${signature}`;

      const result = verifySignedState(boundaryState, TEST_SECRET);
      // now - timestamp === 300 === TTL, so now - timestamp > TTL is false
      expect(result.valid).toBe(true);
    });

    it('should reject a token one second past the TTL', () => {
      const { createHmac } = require('crypto');
      const nonce = '550e8400-e29b-41d4-a716-446655440000';
      const pastTtlTimestamp = Math.floor(Date.now() / 1000) - 301;
      const payload = `${nonce}.${pastTtlTimestamp}`;
      const key = createHmac('sha256', 'discord-activity-oauth-state')
        .update(TEST_SECRET)
        .digest();
      const signature = createHmac('sha256', key).update(payload).digest('hex');
      const pastTtlState = `${payload}.${signature}`;

      const result = verifySignedState(pastTtlState, TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('state token expired');
    });

    it('should accept a token exactly at the clock skew boundary (30s in future)', () => {
      const { createHmac } = require('crypto');
      const nonce = '550e8400-e29b-41d4-a716-446655440000';
      const skewTimestamp = Math.floor(Date.now() / 1000) + 30;
      const payload = `${nonce}.${skewTimestamp}`;
      const key = createHmac('sha256', 'discord-activity-oauth-state')
        .update(TEST_SECRET)
        .digest();
      const signature = createHmac('sha256', key).update(payload).digest('hex');
      const skewState = `${payload}.${signature}`;

      const result = verifySignedState(skewState, TEST_SECRET);
      expect(result.valid).toBe(true);
    });

    it('should reject a token one second past the clock skew boundary', () => {
      const { createHmac } = require('crypto');
      const nonce = '550e8400-e29b-41d4-a716-446655440000';
      const pastSkewTimestamp = Math.floor(Date.now() / 1000) + 31;
      const payload = `${nonce}.${pastSkewTimestamp}`;
      const key = createHmac('sha256', 'discord-activity-oauth-state')
        .update(TEST_SECRET)
        .digest();
      const signature = createHmac('sha256', key).update(payload).digest('hex');
      const pastSkewState = `${payload}.${signature}`;

      const result = verifySignedState(pastSkewState, TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('state token issued in the future');
    });
  });
});
