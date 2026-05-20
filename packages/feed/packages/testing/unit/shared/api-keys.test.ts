/**
 * API Key Utilities Unit Tests
 * Tests for API key generation and verification
 */

import { describe, expect, it } from 'bun:test';
import {
  generateApiKey,
  generateTestApiKey,
  hashApiKey,
  verifyApiKey,
} from '@babylon/api';

describe('API Key Utilities', () => {
  describe('generateApiKey', () => {
    it('should generate a key with correct prefix', () => {
      const key = generateApiKey();
      expect(key.startsWith('bab_live_')).toBe(true);
    });

    it('should generate unique keys', () => {
      const keys = [
        generateApiKey(),
        generateApiKey(),
        generateApiKey(),
        generateApiKey(),
        generateApiKey(),
      ];

      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    });

    it('should generate keys of consistent length', () => {
      const key1 = generateApiKey();
      const key2 = generateApiKey();

      // bab_live_ prefix (9) + 64 hex chars (32 bytes * 2) = 73
      expect(key1.length).toBe(73);
      expect(key2.length).toBe(73);
    });

    it('should only contain valid characters', () => {
      const key = generateApiKey();
      const suffix = key.replace('bab_live_', '');
      expect(/^[a-f0-9]+$/.test(suffix)).toBe(true);
    });
  });

  describe('generateTestApiKey', () => {
    it('should generate a key with test prefix', () => {
      const key = generateTestApiKey();
      expect(key.startsWith('bab_test_')).toBe(true);
    });

    it('should generate unique test keys', () => {
      const keys = [
        generateTestApiKey(),
        generateTestApiKey(),
        generateTestApiKey(),
      ];

      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    });
  });

  describe('hashApiKey', () => {
    it('should produce consistent hashes for same input', () => {
      const key = generateApiKey();
      const hash1 = hashApiKey(key);
      const hash2 = hashApiKey(key);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different inputs', () => {
      const key1 = generateApiKey();
      const key2 = generateApiKey();

      const hash1 = hashApiKey(key1);
      const hash2 = hashApiKey(key2);

      expect(hash1).not.toBe(hash2);
    });

    it('should produce 64-character hex hash', () => {
      const key = generateApiKey();
      const hash = hashApiKey(key);

      expect(hash.length).toBe(64);
      expect(/^[a-f0-9]+$/.test(hash)).toBe(true);
    });
  });

  describe('verifyApiKey', () => {
    it('should verify correct API key against hash', () => {
      const key = generateApiKey();
      const hash = hashApiKey(key);

      expect(verifyApiKey(key, hash)).toBe(true);
    });

    it('should reject incorrect API key', () => {
      const key1 = generateApiKey();
      const key2 = generateApiKey();
      const hash1 = hashApiKey(key1);

      expect(verifyApiKey(key2, hash1)).toBe(false);
    });

    it('should reject modified API key', () => {
      const key = generateApiKey();
      const hash = hashApiKey(key);
      const modifiedKey = key + 'x';

      expect(verifyApiKey(modifiedKey, hash)).toBe(false);
    });
  });
});
