import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PostgresConnectionManager } from '../../../pg/manager';
import { Pool } from 'pg';

// Mock the 'pg' module to avoid actual DB connections in unit tests
vi.mock('pg', () => {
  // Create a reusable mock pool object
  const mockPool = {
    connect: vi.fn(),
    end: vi.fn(),
    query: vi.fn(),
  };
  // The module exports a class named Pool
  return {
    Pool: vi.fn(() => mockPool),
  };
});

describe('PostgresConnectionManager', () => {
  let mockPoolInstance: any;

  beforeEach(() => {
    // Get the instance of the mocked Pool
    mockPoolInstance = new (vi.mocked(Pool, true))();
  });

  afterEach(() => {
    // Clear all mocks after each test
    vi.clearAllMocks();
  });

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
      expect(db.query).toBeDefined();
    });
  });

  describe('getConnection', () => {
    it('should return the pool instance', () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);
      
      const connection = manager.getConnection();
      expect(connection).toBeDefined();
      expect(connection).toBe(mockPoolInstance);
    });
  });

  describe('getClient', () => {
    it('should return a client from the pool', async () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);
      
      const mockClient = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn()
      };
      
      mockPoolInstance.connect.mockResolvedValue(mockClient);
      
      const client = await manager.getClient();
      expect(client).toBe(mockClient);
      expect(mockPoolInstance.connect).toHaveBeenCalled();
    });

    it('should throw error when pool connection fails', async () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);
      
      mockPoolInstance.connect.mockRejectedValue(new Error('Connection failed'));
      
      await expect(manager.getClient()).rejects.toThrow('Connection failed');
    });
  });

  describe('testConnection', () => {
    it('should return true when connection is successful', async () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);
      
      const mockClient = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn()
      };
      
      mockPoolInstance.connect.mockResolvedValue(mockClient);
      
      const result = await manager.testConnection();
      expect(result).toBe(true);
      expect(mockPoolInstance.connect).toHaveBeenCalled();
      expect(mockClient.query).toHaveBeenCalledWith('SELECT 1');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should return false when connection fails', async () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);
      
      mockPoolInstance.connect.mockRejectedValue(new Error('Connection failed'));
      
      const result = await manager.testConnection();
      expect(result).toBe(false);
    });

    it('should return false when query fails', async () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);
      
      const mockClient = {
        query: vi.fn().mockRejectedValue(new Error('Query failed')),
        release: vi.fn()
      };
      
      mockPoolInstance.connect.mockResolvedValue(mockClient);
      
      const result = await manager.testConnection();
      expect(result).toBe(false);
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('should end the pool connection', async () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);
      
      await manager.close();
      expect(mockPoolInstance.end).toHaveBeenCalled();
    });

    it('should propagate errors during close', async () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);
      
      mockPoolInstance.end.mockRejectedValue(new Error('Close failed'));
      
      await expect(manager.close()).rejects.toThrow('Close failed');
    });
  });
}); 