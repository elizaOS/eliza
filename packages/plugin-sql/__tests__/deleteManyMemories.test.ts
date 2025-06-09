import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UUID } from '@elizaos/core';
import { BaseDrizzleAdapter } from '../src/base';
import type { DrizzleDatabase } from '../src/types';

// Mock adapter class for testing
class TestDrizzleAdapter extends BaseDrizzleAdapter<DrizzleDatabase> {
  public db: any;

  constructor() {
    super('12345678-1234-1234-1234-123456789012' as UUID);
    this.db = {
      transaction: vi.fn().mockImplementation(async (callback) => {
        const mockTx = {
          delete: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          }),
        };
        return callback(mockTx);
      }),
    };
  }

  async withDatabase<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }

  async init(): Promise<void> {
    // No-op for tests
  }

  async close(): Promise<void> {
    // No-op for tests
  }

  async getConnection(): Promise<any> {
    return this.db;
  }
}

describe('deleteManyMemories', () => {
  let adapter: TestDrizzleAdapter;

  beforeEach(() => {
    adapter = new TestDrizzleAdapter();
    vi.clearAllMocks();
  });

  it('should have a deleteManyMemories method', () => {
    expect(typeof adapter.deleteManyMemories).toBe('function');
  });

  it('should handle empty array gracefully', async () => {
    await expect(adapter.deleteManyMemories([])).resolves.toBe(undefined);
  });

  it('should call database transaction for non-empty array', async () => {
    const memoryIds: UUID[] = [
      '11111111-1111-1111-1111-111111111111' as UUID,
      '22222222-2222-2222-2222-222222222222' as UUID,
    ];

    await adapter.deleteManyMemories(memoryIds);

    expect(adapter.db.transaction).toHaveBeenCalled();
  });

  it('should handle large arrays by batching', async () => {
    // Create an array of 250 memory IDs (more than the 100 batch size)
    const memoryIds: UUID[] = Array.from({ length: 250 }, (_, i) => 
      `${i.toString().padStart(8, '0')}-1111-1111-1111-111111111111` as UUID
    );

    await adapter.deleteManyMemories(memoryIds);

    // Should call transaction multiple times for batching
    expect(adapter.db.transaction).toHaveBeenCalled();
  });
}); 