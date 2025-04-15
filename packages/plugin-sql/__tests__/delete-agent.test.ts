import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { BaseDrizzleAdapter } from '../src/base';
import { logger, type UUID } from '@elizaos/core';
import {
  agentTable,
  entityTable,
  logTable,
  memoryTable,
  roomTable,
  componentTable,
  participantTable,
  cacheTable,
  relationshipTable,
  worldTable,
  embeddingTable,
} from '../src/schema';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import type { DrizzleDatabase } from '../src/types';

// Mock the logger to avoid console output during tests
vi.mock('@elizaos/core', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  VECTOR_DIMS: {
    SMALL: 'small',
    MEDIUM: 'medium',
    LARGE: 'large',
  },
  DatabaseAdapter: class {
    constructor() {}
    async init() {}
    async close() {}
    async deleteAgent(agentId: UUID) {
      // Default implementation that will be replaced in tests
      return true;
    }
  },
}));

// Create a test adapter class that extends BaseDrizzleAdapter
class TestDrizzleAdapter extends BaseDrizzleAdapter<DrizzleDatabase> {
  public db: DrizzleDatabase;

  constructor() {
    // Use a fixed UUID that matches the required format
    super('12345678-1234-1234-1234-123456789012' as UUID);
    // Mock the database methods
    this.db = {
      transaction: vi.fn().mockImplementation(async (callback) => {
        return callback({
          select: vi.fn().mockReturnThis(),
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          delete: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          insert: vi.fn().mockReturnThis(),
          update: vi.fn().mockReturnThis(),
          set: vi.fn().mockReturnThis(),
          values: vi.fn().mockReturnThis(),
        });
      }),
    } as any;
  }

  // Implement required abstract methods
  async withDatabase<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }

  // Implement required init method
  async init(): Promise<void> {
    // No-op for tests
  }

  // Implement required close method
  async close(): Promise<void> {
    // No-op for tests
  }

  // DeleteAgent method is inherited from BaseDrizzleAdapter
  // and doesn't need to be reimplemented here
}

describe('deleteAgent', () => {
  let adapter: TestDrizzleAdapter;
  const testAgentId = uuidv4() as UUID;
  const mockEntityIds = [uuidv4() as UUID, uuidv4() as UUID];

  beforeEach(() => {
    adapter = new TestDrizzleAdapter();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should successfully delete an agent with no related data', async () => {
    // Create a more sophisticated mock for select
    const mockSelect = vi.fn().mockImplementation(() => {
      return {
        from: vi.fn().mockImplementation(() => {
          return {
            where: vi.fn().mockResolvedValue([]),
          };
        }),
      };
    });

    // Fix the mockDelete to support where method correctly
    const whereImpl = vi.fn().mockReturnThis();
    const mockDelete = vi.fn().mockImplementation(() => {
      return {
        where: whereImpl,
      };
    });

    const mockTx = {
      select: mockSelect,
      delete: mockDelete,
    };

    (adapter.db.transaction as any).mockImplementation(async (callback) => {
      return callback(mockTx);
    });

    const result = await adapter.deleteAgent(testAgentId);

    // Verify that the method attempted to delete the agent
    expect(mockDelete).toHaveBeenCalledWith(agentTable);
    expect(whereImpl).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('should handle foreign key constraint violations gracefully', async () => {
    // Create a more sophisticated mock for select
    const mockSelect = vi.fn().mockImplementation(() => {
      return {
        from: vi.fn().mockImplementation(() => {
          return {
            where: vi.fn().mockResolvedValue([]),
          };
        }),
      };
    });

    // Mock to throw an error on where
    const whereImpl = vi.fn().mockImplementation(() => {
      throw new Error('foreign key constraint violation');
    });

    const mockDelete = vi.fn().mockImplementation(() => {
      return {
        where: whereImpl,
      };
    });

    const mockTx = {
      select: mockSelect,
      delete: mockDelete,
    };

    (adapter.db.transaction as any).mockImplementation(async (callback) => {
      return callback(mockTx);
    });

    // The method should throw the error
    await expect(adapter.deleteAgent(testAgentId)).rejects.toThrow(
      'foreign key constraint violation'
    );
  });

  it('should handle transaction timeout', async () => {
    // Mock a transaction that times out
    (adapter.db.transaction as any).mockImplementation(async () => {
      return new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('Database transaction timeout'));
        }, 100);
      });
    });

    // The method should throw a timeout error
    await expect(adapter.deleteAgent(testAgentId)).rejects.toThrow('Database transaction timeout');
  });

  it('should delete an agent and all related data', async () => {
    // Create mock entities result
    const mockEntitiesResult = mockEntityIds.map((id) => ({ entityId: id }));
    const mockRoomIds = [uuidv4() as UUID];
    const mockMemoryIds = [uuidv4() as UUID];
    const mockWorldIds = [uuidv4() as UUID];

    // Track which tables have been deleted to verify order
    const deletedTables: any[] = [];

    // Create a more sophisticated mock for select
    const mockSelect = vi.fn().mockImplementation((fields) => {
      return {
        from: vi.fn().mockImplementation((table) => {
          return {
            where: vi.fn().mockImplementation(() => {
              // Return entity IDs only for entity table queries
              if (table === entityTable) {
                return Promise.resolve(mockEntitiesResult);
              }
              // For memory table queries, return some mock memory IDs
              if (table === memoryTable) {
                // This will ensure that we have a non-empty array of memory IDs,
                // which should cause the memoryTable deletion to be called
                return Promise.resolve(mockMemoryIds.map((id) => ({ id })));
              }
              // Return room IDs for room queries
              if (table === roomTable) {
                return Promise.resolve(mockRoomIds.map((id) => ({ roomId: id })));
              }
              // Return world IDs for world queries
              if (table === worldTable) {
                return Promise.resolve(mockWorldIds.map((id) => ({ id })));
              }
              return Promise.resolve([]);
            }),
          };
        }),
      };
    });

    // Fix the mockDelete to support where method correctly
    const whereImpl = vi.fn().mockImplementation(() => {
      return Promise.resolve();
    });

    const mockDelete = vi.fn().mockImplementation((table: any) => {
      deletedTables.push(table);
      return {
        where: whereImpl,
      };
    });

    const mockTx = {
      select: mockSelect,
      delete: mockDelete,
    };

    (adapter.db.transaction as any).mockImplementation(async (callback) => {
      return callback(mockTx);
    });

    const result = await adapter.deleteAgent(testAgentId);

    // Verify the deletion of related data was called in the correct order
    expect(deletedTables).toContain(logTable);
    expect(deletedTables).toContain(embeddingTable);
    expect(deletedTables).toContain(memoryTable);
    expect(deletedTables).toContain(componentTable);
    expect(deletedTables).toContain(participantTable);
    expect(deletedTables).toContain(roomTable);
    expect(deletedTables).toContain(cacheTable);
    expect(deletedTables).toContain(relationshipTable);
    expect(deletedTables).toContain(entityTable);
    expect(deletedTables).toContain(worldTable);
    expect(deletedTables).toContain(agentTable);

    // Verify the agent table was deleted last
    expect(deletedTables.indexOf(agentTable)).toBeGreaterThan(deletedTables.indexOf(entityTable));
    expect(result).toBe(true);
  });
});
