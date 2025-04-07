import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { BaseDrizzleAdapter } from '../src/base';
import { logger } from '@elizaos/core';
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
    async deleteAgent() {}
  },
}));

// Create a test adapter class that extends BaseDrizzleAdapter
class TestDrizzleAdapter extends BaseDrizzleAdapter<DrizzleDatabase> {
  public db: DrizzleDatabase;

  constructor() {
    // Use a fixed UUID that matches the required format
    super('12345678-1234-1234-1234-123456789012');
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

  // Implement deleteAgent method
  async deleteAgent(agentId: string): Promise<boolean> {
    return this.withDatabase(async () => {
      await this.db.transaction(async (tx) => {
        // First, delete related data
        // Delete logs associated with the agent's entities
        const agentEntities = await tx
          .select({ id: entityTable.id })
          .from(entityTable)
          .where(eq(entityTable.agentId, agentId));

        const entityIds = agentEntities.map((e) => e.id);
        if (entityIds.length > 0) {
          await tx.delete(logTable).where(inArray(logTable.entityId, entityIds));
        }

        // Delete memories associated with the agent's entities
        if (entityIds.length > 0) {
          await tx.delete(memoryTable).where(inArray(memoryTable.entityId, entityIds));
        }

        // Delete components associated with the agent's entities
        if (entityIds.length > 0) {
          await tx.delete(componentTable).where(inArray(componentTable.entityId, entityIds));
        }

        // Delete relationships where agent's entities are involved
        if (entityIds.length > 0) {
          await tx
            .delete(relationshipTable)
            .where(inArray(relationshipTable.sourceEntityId, entityIds));
          await tx
            .delete(relationshipTable)
            .where(inArray(relationshipTable.targetEntityId, entityIds));
        }

        // Delete cache entries associated with the agent
        await tx.delete(cacheTable).where(eq(cacheTable.agentId, agentId));

        // Delete the agent's entities
        await tx.delete(entityTable).where(eq(entityTable.agentId, agentId));

        // Finally, delete the agent itself
        await tx.delete(agentTable).where(eq(agentTable.id, agentId));
      });
      return true;
    });
  }
}

describe('deleteAgent', () => {
  let adapter: TestDrizzleAdapter;
  const testAgentId = uuidv4();

  beforeEach(() => {
    adapter = new TestDrizzleAdapter();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should successfully delete an agent with no related data', async () => {
    // Mock the database to return empty arrays for all queries
    const mockTx = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
      })),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };

    (adapter.db.transaction as any).mockImplementation(async (callback) => {
      return callback(mockTx);
    });

    const result = await adapter.deleteAgent(testAgentId);

    // Verify that the method attempted to delete the agent
    expect(mockTx.delete).toHaveBeenCalledWith(agentTable);
    expect(result).toBe(true);
  });

  it('should handle foreign key constraint violations gracefully', async () => {
    // Mock the database to return empty arrays for all queries
    const mockTx = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
      })),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      delete: vi.fn().mockImplementation(() => {
        throw new Error('foreign key constraint violation');
      }),
      limit: vi.fn().mockReturnThis(),
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
    // Mock the database to return some entities
    const mockEntities = [{ id: uuidv4() }, { id: uuidv4() }];

    const mockTx = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(mockEntities),
      })),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };

    (adapter.db.transaction as any).mockImplementation(async (callback) => {
      return callback(mockTx);
    });

    const result = await adapter.deleteAgent(testAgentId);

    // Verify that the method attempted to delete all related data
    expect(mockTx.select).toHaveBeenCalledWith({ id: entityTable.id });
    expect(mockTx.delete).toHaveBeenCalledWith(logTable);
    expect(mockTx.delete).toHaveBeenCalledWith(memoryTable);
    expect(mockTx.delete).toHaveBeenCalledWith(componentTable);
    expect(mockTx.delete).toHaveBeenCalledWith(relationshipTable);
    expect(mockTx.delete).toHaveBeenCalledWith(cacheTable);
    expect(mockTx.delete).toHaveBeenCalledWith(entityTable);
    expect(mockTx.delete).toHaveBeenCalledWith(agentTable);
    expect(result).toBe(true);
  });
});
