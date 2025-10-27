import { describe, it, expect } from 'bun:test';
import { generateSessionId } from '../utils/session';

describe('CLI Login', () => {
  describe('generateSessionId', () => {
    it('should generate a unique session ID', () => {
      const id1 = generateSessionId();
      const id2 = generateSessionId();

      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);
      expect(id1.length).toBeGreaterThan(0);
    });

    it('should generate a hex string', () => {
      const sessionId = generateSessionId();

      // Hex string should only contain 0-9 and a-f
      expect(sessionId).toMatch(/^[0-9a-f]+$/);
    });

    it('should generate a 64-character string', () => {
      const sessionId = generateSessionId();

      // 32 bytes = 64 hex characters
      expect(sessionId.length).toBe(64);
    });
  });
});
