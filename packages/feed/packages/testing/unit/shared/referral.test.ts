/**
 * Referral Utilities Unit Tests
 * Tests for referral URL generation utilities
 */

import { describe, expect, it } from 'bun:test';
import { getReferralShareText, getReferralUrl } from '@babylon/shared';

describe('Referral Utilities', () => {
  describe('getReferralUrl', () => {
    it('should generate referral URL with username', () => {
      const url = getReferralUrl('testuser');
      expect(url).toContain('testuser');
      // URL format is ?ref=username
      expect(url).toContain('ref=');
    });

    it('should generate valid URL format', () => {
      const url = getReferralUrl('testuser');
      // Should be a valid URL
      expect(() => new URL(url)).not.toThrow();
    });

    it('should handle different usernames', () => {
      const url1 = getReferralUrl('user1');
      const url2 = getReferralUrl('user2');
      expect(url1).not.toBe(url2);
    });
  });

  describe('getReferralShareText', () => {
    it('should generate share text with default message', () => {
      const text = getReferralShareText('testuser');
      expect(text).toContain('testuser');
      expect(text).toContain('Babylon');
    });

    it('should include referral URL', () => {
      const text = getReferralShareText('testuser');
      const url = getReferralUrl('testuser');
      expect(text).toContain(url);
    });

    it('should use custom message when provided', () => {
      const customMessage = 'Check out this awesome platform!';
      const text = getReferralShareText('testuser', customMessage);
      expect(text).toContain(customMessage);
    });

    it('should separate message and URL with newlines', () => {
      const text = getReferralShareText('testuser');
      expect(text).toContain('\n\n');
    });
  });
});
