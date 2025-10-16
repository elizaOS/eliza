/**
 * CLI API Exports Tests
 *
 * Tests to ensure the server package exports the correct API that the CLI uses.
 * These tests only verify exports exist - they don't test behavior (that's covered by other tests).
 */

import { describe, it, expect } from 'bun:test';

describe('CLI API Exports', () => {
  describe('AgentServer Class', () => {
    it('should export AgentServer class', async () => {
      const { AgentServer } = await import('../');

      expect(AgentServer).toBeDefined();
      expect(typeof AgentServer).toBe('function');
    });

    it('should have required methods', async () => {
      const { AgentServer } = await import('../');
      const server = new AgentServer();

      // Check methods that CLI uses
      expect(typeof server.start).toBe('function');
      expect(typeof server.stop).toBe('function');
      expect(typeof server.registerAgent).toBe('function');
      expect(typeof server.unregisterAgent).toBe('function');
      expect(typeof server.registerMiddleware).toBe('function');
      expect(typeof server.startAgents).toBe('function');
    });

    it('should have isInitialized property', async () => {
      const { AgentServer } = await import('../');
      const server = new AgentServer();

      expect(server.hasOwnProperty('isInitialized')).toBe(true);
      expect(typeof server.isInitialized).toBe('boolean');
    });
  });

  describe('Loader Functions', () => {
    it('should export loadCharacterTryPath', async () => {
      const { loadCharacterTryPath } = await import('../');

      expect(loadCharacterTryPath).toBeDefined();
      expect(typeof loadCharacterTryPath).toBe('function');
    });

    it('should export jsonToCharacter', async () => {
      const { jsonToCharacter } = await import('../');

      expect(jsonToCharacter).toBeDefined();
      expect(typeof jsonToCharacter).toBe('function');
    });

    it('should export other loader utilities', async () => {
      const {
        tryLoadFile,
        loadCharactersFromUrl,
        loadCharacter,
        hasValidRemoteUrls,
        loadCharacters,
      } = await import('../');

      expect(tryLoadFile).toBeDefined();
      expect(loadCharactersFromUrl).toBeDefined();
      expect(loadCharacter).toBeDefined();
      expect(hasValidRemoteUrls).toBeDefined();
      expect(loadCharacters).toBeDefined();
    });
  });

  describe('Utility Functions', () => {
    it('should export expandTildePath', async () => {
      const { expandTildePath } = await import('../');

      expect(expandTildePath).toBeDefined();
      expect(typeof expandTildePath).toBe('function');
    });

    it('should export resolvePgliteDir', async () => {
      const { resolvePgliteDir } = await import('../');

      expect(resolvePgliteDir).toBeDefined();
      expect(typeof resolvePgliteDir).toBe('function');
    });
  });
});
