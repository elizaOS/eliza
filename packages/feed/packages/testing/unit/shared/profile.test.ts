/**
 * Tests for Profile URL utilities
 */
import { describe, expect, it } from 'bun:test';
import {
  extractUsername,
  getActorProfileUrl,
  getOrganizationProfileUrl,
  getProfileUrl,
  getUserProfileUrl,
  isUsername,
} from '@feed/shared/utils/profile';

describe('Profile URL Utilities', () => {
  describe('getProfileUrl', () => {
    it('should generate URL with username when provided', () => {
      const result = getProfileUrl('user_123', 'alice');
      expect(result).toBe('/profile/alice');
    });

    it('should generate URL with user ID when no username', () => {
      const result = getProfileUrl('user_123', null);
      expect(result).toBe('/profile/user_123');
    });

    it('should generate URL with user ID when username is undefined', () => {
      const result = getProfileUrl('user_123');
      expect(result).toBe('/profile/user_123');
    });

    it('should strip @ prefix from username', () => {
      const result = getProfileUrl('user_123', '@alice');
      expect(result).toBe('/profile/alice');
    });

    it('should handle empty string username as falsy', () => {
      const result = getProfileUrl('user_123', '');
      expect(result).toBe('/profile/user_123');
    });
  });

  describe('getUserProfileUrl', () => {
    it('should generate canonical user URL with username when provided', () => {
      const result = getUserProfileUrl('user_123', 'alice');
      expect(result).toBe('/u/alice');
    });

    it('should strip @ prefix from username', () => {
      const result = getUserProfileUrl('user_123', '@alice');
      expect(result).toBe('/u/alice');
    });

    it('should fall back to id-based URL when no username', () => {
      const result = getUserProfileUrl('user_123', null);
      expect(result).toBe('/u/id/user_123');
    });
  });

  describe('getActorProfileUrl', () => {
    it('should generate canonical actor URL', () => {
      expect(getActorProfileUrl('actor_1')).toBe('/actors/actor_1');
    });
  });

  describe('getOrganizationProfileUrl', () => {
    it('should generate canonical organization URL', () => {
      expect(getOrganizationProfileUrl('org_1')).toBe('/orgs/org_1');
    });
  });

  describe('isUsername', () => {
    it('should return true for simple usernames', () => {
      expect(isUsername('alice')).toBe(true);
      expect(isUsername('bob123')).toBe(true);
      expect(isUsername('user_name')).toBe(true);
    });

    it('should return true for usernames starting with @', () => {
      expect(isUsername('@alice')).toBe(true);
      expect(isUsername('@bob123')).toBe(true);
    });

    it('should return false for DID identifiers', () => {
      expect(isUsername('did:privy:abc123')).toBe(false);
      expect(isUsername('did:ethr:0x123')).toBe(false);
    });

    it('should return false for identifiers containing privy', () => {
      expect(isUsername('privy-user-123')).toBe(false);
      expect(isUsername('some-privy-id')).toBe(false);
      expect(isUsername('PRIVY_USER')).toBe(false);
    });

    it('should return false for UUID identifiers', () => {
      expect(isUsername('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
      expect(isUsername('123e4567-e89b-12d3-a456-426614174000')).toBe(false);
    });

    it('should return false for identifiers with dashes (non-UUID)', () => {
      expect(isUsername('some-user-id')).toBe(false);
    });

    it('should return true for long usernames without dashes', () => {
      // Usernames can be up to 42 characters
      const longUsername = 'a'.repeat(42);
      expect(isUsername(longUsername)).toBe(true);
    });

    it('should return false for very long identifiers', () => {
      // Over 42 characters without dashes is likely not a username
      const longId = 'a'.repeat(43);
      expect(isUsername(longId)).toBe(false);
    });
  });

  describe('extractUsername', () => {
    it('should remove @ prefix', () => {
      expect(extractUsername('@alice')).toBe('alice');
    });

    it('should return username unchanged if no @ prefix', () => {
      expect(extractUsername('alice')).toBe('alice');
    });

    it('should handle empty strings', () => {
      expect(extractUsername('')).toBe('');
    });

    it('should only remove leading @', () => {
      expect(extractUsername('@alice@example.com')).toBe('alice@example.com');
    });

    it('should not remove @ if not at start', () => {
      expect(extractUsername('alice@example.com')).toBe('alice@example.com');
    });
  });
});
