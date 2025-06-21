import { describe, it, expect } from 'vitest';
import { PgliteDatabaseAdapter } from '../../../pglite/adapter';

describe('PgliteDatabaseAdapter', () => {
  const agentId = '00000000-0000-0000-0000-000000000000';

  describe('constructor', () => {
    it('should require agentId and manager', () => {
      // Create a mock manager with minimal interface
      const mockManager = {
        getConnection: () => ({
          query: () => Promise.resolve({ rows: [] }),
          close: () => Promise.resolve(),
          transaction: () => {},
        }),
        close: () => Promise.resolve(),
        isShuttingDown: () => false,
      };

      const adapter = new PgliteDatabaseAdapter(agentId, mockManager);
      expect(adapter).toBeDefined();
      expect((adapter as any).agentId).toBe(agentId);
      expect((adapter as any).manager).toBe(mockManager);
    });

    it('should set embeddingDimension to default 384', () => {
      const mockManager = {
        getConnection: () => ({
          query: () => Promise.resolve({ rows: [] }),
          close: () => Promise.resolve(),
          transaction: () => {},
        }),
        close: () => Promise.resolve(),
        isShuttingDown: () => false,
      };

      const adapter = new PgliteDatabaseAdapter(agentId, mockManager);
      expect((adapter as any).embeddingDimension).toBe('dim384');
    });
  });

  describe('methods', () => {
    it('should have required methods', () => {
      const mockManager = {
        getConnection: () => ({
          query: () => Promise.resolve({ rows: [] }),
          close: () => Promise.resolve(),
          transaction: () => {},
        }),
        close: () => Promise.resolve(),
        isShuttingDown: () => false,
      };

      const adapter = new PgliteDatabaseAdapter(agentId, mockManager);
      
      expect(typeof adapter.runMigrations).toBe('function');
      expect(typeof adapter.init).toBe('function');
      expect(typeof adapter.isReady).toBe('function');
      expect(typeof adapter.close).toBe('function');
      expect(typeof adapter.getConnection).toBe('function');
    });
  });
});
