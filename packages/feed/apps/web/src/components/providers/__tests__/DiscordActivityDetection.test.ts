/**
 * Tests for Discord Activity Detection Heuristics
 *
 * Tests the pure detection logic used in DiscordActivityProvider to
 * determine if the app is running inside a Discord Activity iframe.
 *
 * Covers:
 * - Hostname-based detection (*.discordsays.com)
 * - Query parameter detection (frame_id + instance_id)
 * - iframe detection (window.self !== window.top)
 * - Error classification (isNotAnActivity vs real errors)
 * - Combined heuristic logic
 */

import { describe, expect, it } from 'bun:test';

/**
 * Replicate Discord Activity detection logic from DiscordActivityProvider.
 * Tests the hostname + query param + iframe heuristic.
 */
function isLikelyDiscord(
  hostname: string,
  searchParams: URLSearchParams,
  isInIframe: boolean
): boolean {
  const isDiscordHostname = hostname.endsWith('.discordsays.com');
  const hasDiscordParams =
    searchParams.has('frame_id') && searchParams.has('instance_id');
  return isDiscordHostname || (isInIframe && hasDiscordParams);
}

/**
 * Replicate Discord error classification logic from DiscordActivityProvider.
 * Determines if an SDK error means "not in Discord" vs an actual failure.
 */
function isNotAnActivityError(message: string): boolean {
  return (
    message.includes('not running in Discord') ||
    message.includes('READY') ||
    message.includes('postMessage')
  );
}

describe('Discord Activity Detection Heuristics', () => {
  describe('isLikelyDiscord', () => {
    it('should detect *.discordsays.com hostname', () => {
      const result = isLikelyDiscord(
        'abc123.discordsays.com',
        new URLSearchParams(),
        false
      );
      expect(result).toBe(true);
    });

    it('should detect subdomain of discordsays.com', () => {
      const result = isLikelyDiscord(
        'my-app.12345.discordsays.com',
        new URLSearchParams(),
        false
      );
      expect(result).toBe(true);
    });

    it('should NOT detect plain discordsays.com without leading dot match', () => {
      // 'discordsays.com'.endsWith('.discordsays.com') === false
      const result = isLikelyDiscord(
        'discordsays.com',
        new URLSearchParams(),
        false
      );
      expect(result).toBe(false);
    });

    it('should NOT detect a similar but different hostname', () => {
      const result = isLikelyDiscord(
        'notdiscordsays.com',
        new URLSearchParams(),
        false
      );
      expect(result).toBe(false);
    });

    it('should detect iframe + Discord query params', () => {
      const params = new URLSearchParams({
        frame_id: 'abc',
        instance_id: 'def',
      });
      const result = isLikelyDiscord('localhost', params, true);
      expect(result).toBe(true);
    });

    it('should NOT detect Discord params without iframe', () => {
      const params = new URLSearchParams({
        frame_id: 'abc',
        instance_id: 'def',
      });
      // Not in iframe — should not trigger detection
      const result = isLikelyDiscord('localhost', params, false);
      expect(result).toBe(false);
    });

    it('should NOT detect iframe without Discord params', () => {
      const result = isLikelyDiscord('localhost', new URLSearchParams(), true);
      expect(result).toBe(false);
    });

    it('should NOT detect iframe with only frame_id param', () => {
      const params = new URLSearchParams({ frame_id: 'abc' });
      const result = isLikelyDiscord('localhost', params, true);
      expect(result).toBe(false);
    });

    it('should NOT detect iframe with only instance_id param', () => {
      const params = new URLSearchParams({ instance_id: 'def' });
      const result = isLikelyDiscord('localhost', params, true);
      expect(result).toBe(false);
    });

    it('should NOT detect standard web context', () => {
      const result = isLikelyDiscord(
        'babylon.market',
        new URLSearchParams(),
        false
      );
      expect(result).toBe(false);
    });

    it('should detect Discord hostname even when NOT in iframe', () => {
      // Hostname check is sufficient on its own
      const result = isLikelyDiscord(
        'test.discordsays.com',
        new URLSearchParams(),
        false
      );
      expect(result).toBe(true);
    });

    it('should detect with both hostname AND params present', () => {
      const params = new URLSearchParams({
        frame_id: 'abc',
        instance_id: 'def',
      });
      const result = isLikelyDiscord('test.discordsays.com', params, true);
      expect(result).toBe(true);
    });
  });

  describe('isNotAnActivityError', () => {
    it('should classify "not running in Discord" as non-activity', () => {
      expect(
        isNotAnActivityError('Error: not running in Discord environment')
      ).toBe(true);
    });

    it('should classify READY timeout as non-activity', () => {
      expect(isNotAnActivityError('Timed out waiting for READY event')).toBe(
        true
      );
    });

    it('should classify postMessage errors as non-activity', () => {
      expect(
        isNotAnActivityError('Failed to execute postMessage on DOMWindow')
      ).toBe(true);
    });

    it('should NOT classify network errors as non-activity', () => {
      expect(isNotAnActivityError('NetworkError: Failed to fetch')).toBe(false);
    });

    it('should NOT classify generic errors as non-activity', () => {
      expect(isNotAnActivityError('Something went wrong')).toBe(false);
    });

    it('should NOT classify token exchange errors as non-activity', () => {
      expect(
        isNotAnActivityError('Token exchange failed with status 400')
      ).toBe(false);
    });

    it('should NOT classify authentication null as non-activity', () => {
      expect(isNotAnActivityError('Discord authentication returned null')).toBe(
        false
      );
    });

    it('should handle empty error message', () => {
      expect(isNotAnActivityError('')).toBe(false);
    });
  });
});
