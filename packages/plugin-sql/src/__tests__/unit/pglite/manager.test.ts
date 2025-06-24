import { describe, it, expect } from 'bun:test';
import { PGliteClientManager } from '../../../pglite/manager';

describe('PGliteClientManager', () => {
  describe('constructor', () => {
    it('should create a PGLite client with the provided options', () => {
      const manager = new PGliteClientManager({ dataDir: 'memory://' });

      expect(manager).toBeDefined();
      expect(manager.getConnection()).toBeDefined();
    });

    it('should initialize shuttingDown to false', () => {
      const manager = new PGliteClientManager({ dataDir: 'memory://' });
      expect(manager.isShuttingDown()).toBe(false);
    });
  });

  describe('getConnection', () => {
    it('should return the PGLite client', () => {
      const manager = new PGliteClientManager({ dataDir: 'memory://' });
      const client = manager.getConnection();

      expect(client).toBeDefined();
      expect(client.query).toBeDefined();
      expect(client.close).toBeDefined();
    });
  });

  describe('isShuttingDown', () => {
    it('should return false initially', () => {
      const manager = new PGliteClientManager({ dataDir: 'memory://' });
      expect(manager.isShuttingDown()).toBe(false);
    });

    it('should return true after close is called', async () => {
      const manager = new PGliteClientManager({ dataDir: 'memory://' });
      await manager.close();
      expect(manager.isShuttingDown()).toBe(true);
    });
  });

  describe('close', () => {
    it('should set shuttingDown to true immediately', async () => {
      const manager = new PGliteClientManager({ dataDir: 'memory://' });
      expect(manager.isShuttingDown()).toBe(false);

      await manager.close();
      expect(manager.isShuttingDown()).toBe(true);
    });

    it('should return a promise', () => {
      const manager = new PGliteClientManager({ dataDir: 'memory://' });
      const result = manager.close();

      expect(result).toBeInstanceOf(Promise);
    });

    it('should handle multiple close calls', async () => {
      const manager = new PGliteClientManager({ dataDir: 'memory://' });

      // Call close multiple times
      await manager.close();
      await manager.close();
      await manager.close();

      // Should remain in shutting down state
      expect(manager.isShuttingDown()).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle empty data directory', () => {
      const manager = new PGliteClientManager({ dataDir: '' });
      expect(manager).toBeDefined();
      expect(manager.getConnection()).toBeDefined();
    });

    it('should maintain state consistency during concurrent close calls', async () => {
      const manager = new PGliteClientManager({ dataDir: 'memory://' });

      // Start multiple close operations
      const close1 = manager.close();
      const close2 = manager.close();
      const close3 = manager.close();

      // All should return promises
      expect(close1).toBeInstanceOf(Promise);
      expect(close2).toBeInstanceOf(Promise);
      expect(close3).toBeInstanceOf(Promise);

      // Wait for all to complete
      await Promise.all([close1, close2, close3]);

      // Should be in shutting down state
      expect(manager.isShuttingDown()).toBe(true);
    });
  });
});
