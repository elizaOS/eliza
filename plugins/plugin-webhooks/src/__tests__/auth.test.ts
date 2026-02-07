import { describe, it, expect } from 'vitest';
import { extractToken, validateToken } from '../auth.js';

describe('auth', () => {
  describe('extractToken', () => {
    it('extracts from Authorization: Bearer header', () => {
      const req = { headers: { authorization: 'Bearer my-secret-token' } };
      expect(extractToken(req)).toBe('my-secret-token');
    });

    it('extracts from x-otto-token header', () => {
      const req = { headers: { 'x-otto-token': 'my-token' } };
      expect(extractToken(req)).toBe('my-token');
    });

    it('extracts from query param', () => {
      const req = { headers: {}, url: 'http://localhost/hooks/wake?token=query-tok' };
      expect(extractToken(req)).toBe('query-tok');
    });

    it('prefers Authorization over x-otto-token', () => {
      const req = {
        headers: {
          authorization: 'Bearer bearer-tok',
          'x-otto-token': 'header-tok',
        },
      };
      expect(extractToken(req)).toBe('bearer-tok');
    });

    it('returns undefined when no token present', () => {
      const req = { headers: {} };
      expect(extractToken(req)).toBeUndefined();
    });

    it('handles missing headers object', () => {
      const req = {} as { headers?: Record<string, string | undefined> };
      expect(extractToken(req)).toBeUndefined();
    });
  });

  describe('validateToken', () => {
    it('returns true for matching token', () => {
      const req = { headers: { authorization: 'Bearer correct-token' } };
      expect(validateToken(req, 'correct-token')).toBe(true);
    });

    it('returns false for wrong token', () => {
      const req = { headers: { authorization: 'Bearer wrong-token' } };
      expect(validateToken(req, 'correct-token')).toBe(false);
    });

    it('returns false for missing token', () => {
      const req = { headers: {} };
      expect(validateToken(req, 'any-token')).toBe(false);
    });

    it('returns false for different length token', () => {
      const req = { headers: { authorization: 'Bearer short' } };
      expect(validateToken(req, 'much-longer-expected-token')).toBe(false);
    });
  });
});
