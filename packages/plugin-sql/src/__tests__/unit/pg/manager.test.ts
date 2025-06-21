import { describe, it, expect } from 'vitest';
import { PostgresConnectionManager } from '../../../pg/manager';

describe('PostgresConnectionManager', () => {
  describe('constructor', () => {
    it('should create an instance with connection URL', () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);

      expect(manager).toBeDefined();
      expect(manager.getConnection()).toBeDefined();
      expect(manager.getDatabase()).toBeDefined();
    });
  });

  describe('getDatabase', () => {
    it('should return the drizzle database instance', () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);

      const db = manager.getDatabase();
      expect(db).toBeDefined();
      expect(typeof db.query).toBe('object');
    });
  });

  describe('getConnection', () => {
    it('should return the pool instance', () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);

      const connection = manager.getConnection();
      expect(connection).toBeDefined();
      expect(typeof connection.connect).toBe('function');
      expect(typeof connection.end).toBe('function');
    });
  });

  describe('close', () => {
    it('should have a close method', async () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);

      expect(typeof manager.close).toBe('function');
      // Don't actually call close as it would end the pool
    });
  });
});
