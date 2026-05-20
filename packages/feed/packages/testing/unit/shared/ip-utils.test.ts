/**
 * IP Utils Unit Tests
 * Tests for IP address extraction and hashing utilities
 */

import { describe, expect, it } from 'bun:test';

// Import from absolute source path with cache-busting to avoid mocked @babylon/api.
const { getClientIp, getHashedClientIp, hashIpAddress } = await import(
  `${import.meta.dir}/../../../api/src/utils/ip-utils?t=${Date.now()}`
);

describe('IP Utils', () => {
  describe('hashIpAddress', () => {
    it('should produce consistent hashes', () => {
      const ip = '192.168.1.1';
      const hash1 = hashIpAddress(ip);
      const hash2 = hashIpAddress(ip);
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different IPs', () => {
      const hash1 = hashIpAddress('192.168.1.1');
      const hash2 = hashIpAddress('192.168.1.2');
      expect(hash1).not.toBe(hash2);
    });

    it('should produce 64-character hex hash', () => {
      const hash = hashIpAddress('192.168.1.1');
      expect(hash.length).toBe(64);
      expect(/^[a-f0-9]+$/.test(hash)).toBe(true);
    });
  });

  describe('getClientIp', () => {
    it('should extract IP from X-Forwarded-For header', () => {
      const headers = new Headers({
        'x-forwarded-for': '203.0.113.195, 70.41.3.18, 150.172.238.178',
      });
      const ip = getClientIp(headers);
      expect(ip).toBe('203.0.113.195');
    });

    it('should extract IP from X-Real-IP header', () => {
      const headers = new Headers({
        'x-real-ip': '203.0.113.195',
      });
      const ip = getClientIp(headers);
      expect(ip).toBe('203.0.113.195');
    });

    it('should extract IP from CF-Connecting-IP header', () => {
      const headers = new Headers({
        'cf-connecting-ip': '203.0.113.195',
      });
      const ip = getClientIp(headers);
      expect(ip).toBe('203.0.113.195');
    });

    it('should prioritize X-Forwarded-For over other headers', () => {
      const headers = new Headers({
        'x-forwarded-for': '203.0.113.195',
        'x-real-ip': '10.0.0.1',
        'cf-connecting-ip': '10.0.0.2',
      });
      const ip = getClientIp(headers);
      expect(ip).toBe('203.0.113.195');
    });

    it('should return null for empty headers', () => {
      const headers = new Headers();
      const ip = getClientIp(headers);
      expect(ip).toBeNull();
    });

    it('should work with plain object headers', () => {
      const headers = {
        'x-forwarded-for': '203.0.113.195',
      };
      const ip = getClientIp(headers);
      expect(ip).toBe('203.0.113.195');
    });

    it('should work with Map headers', () => {
      const headers = new Map<string, string>([
        ['x-forwarded-for', '203.0.113.195'],
      ]);
      const ip = getClientIp(headers);
      expect(ip).toBe('203.0.113.195');
    });

    it('should handle array header values', () => {
      const headers = {
        'x-forwarded-for': ['203.0.113.195', '10.0.0.1'],
      };
      const ip = getClientIp(headers);
      expect(ip).toBe('203.0.113.195');
    });
  });

  describe('getHashedClientIp', () => {
    it('should return hashed IP when present', () => {
      const headers = new Headers({
        'x-forwarded-for': '203.0.113.195',
      });
      const hash = getHashedClientIp(headers);
      expect(hash).not.toBeNull();
      expect(hash?.length).toBe(64);
    });

    it('should return null when no IP found', () => {
      const headers = new Headers();
      const hash = getHashedClientIp(headers);
      expect(hash).toBeNull();
    });

    it('should produce consistent hashes for same IP', () => {
      const headers1 = new Headers({ 'x-forwarded-for': '203.0.113.195' });
      const headers2 = new Headers({ 'x-real-ip': '203.0.113.195' });
      const hash1 = getHashedClientIp(headers1);
      const hash2 = getHashedClientIp(headers2);
      expect(hash1).toBe(hash2);
    });
  });
});
