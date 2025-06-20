import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { plugin } from '../../index';
import type { IAgentRuntime } from '@elizaos/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('PostgreSQL Initialization Tests', () => {
  let mockRuntime: IAgentRuntime;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.POSTGRES_URL;
    delete process.env.PGLITE_PATH;
    delete process.env.DATABASE_PATH;

    mockRuntime = {
      agentId: '00000000-0000-0000-0000-000000000000',
      getSetting: mock(),
      registerDatabaseAdapter: mock(),
      registerService: mock(),
      getService: mock(),
    } as any;
  });

  afterEach(() => {
    process.env = originalEnv;
    // Mocks auto-clear in bun:test;
  });

  it('should initialize with PostgreSQL when POSTGRES_URL is provided', async () => {
    const postgresUrl = 'postgresql://test:test@localhost:5432/testdb';
    (mockRuntime.getSetting as any).mockImplementation((key: string) => {
      if (key === 'POSTGRES_URL') return postgresUrl;
      return undefined;
    });

    await plugin.init?.({}, mockRuntime);

    expect(mockRuntime.registerDatabaseAdapter).toHaveBeenCalled();
    const adapter = (mockRuntime.registerDatabaseAdapter as any).mock.calls[0][0];
    expect(adapter).toBeDefined();
    expect(adapter.constructor.name).toBe('PgDatabaseAdapter');
  });

  it('should skip initialization if database adapter already exists', async () => {
    // Simulate existing adapter
    (mockRuntime as any).databaseAdapter = { test: true };

    await plugin.init?.({}, mockRuntime);

    expect(mockRuntime.registerDatabaseAdapter).not.toHaveBeenCalled();
  });

  it('should use PGLITE_PATH when provided', async () => {
    // Use a proper temporary directory that actually exists
    const pglitePath = join(tmpdir(), 'eliza-test-pglite-' + Date.now());
    (mockRuntime.getSetting as any).mockImplementation((key: string) => {
      if (key === 'PGLITE_PATH') return pglitePath;
      return undefined;
    });

    await plugin.init?.({}, mockRuntime);

    expect(mockRuntime.registerDatabaseAdapter).toHaveBeenCalled();
    const adapter = (mockRuntime.registerDatabaseAdapter as any).mock.calls[0][0];
    expect(adapter).toBeDefined();
    expect(adapter.constructor.name).toBe('PgliteDatabaseAdapter');
  });

  it('should use DATABASE_PATH when PGLITE_PATH is not provided', async () => {
    // Use a proper temporary directory that actually exists
    const databasePath = join(tmpdir(), 'eliza-test-db-' + Date.now());
    (mockRuntime.getSetting as any).mockImplementation((key: string) => {
      if (key === 'DATABASE_PATH') return databasePath;
      return undefined;
    });

    await plugin.init?.({}, mockRuntime);

    expect(mockRuntime.registerDatabaseAdapter).toHaveBeenCalled();
    const adapter = (mockRuntime.registerDatabaseAdapter as any).mock.calls[0][0];
    expect(adapter).toBeDefined();
    expect(adapter.constructor.name).toBe('PgliteDatabaseAdapter');
  });

  it('should use default path when no configuration is provided', async () => {
    (mockRuntime.getSetting as any).mockReturnValue(undefined);

    await plugin.init?.({}, mockRuntime);

    expect(mockRuntime.registerDatabaseAdapter).toHaveBeenCalled();
    const adapter = (mockRuntime.registerDatabaseAdapter as any).mock.calls[0][0];
    expect(adapter).toBeDefined();
    expect(adapter.constructor.name).toBe('PgliteDatabaseAdapter');
  });

  it('should handle errors gracefully during adapter check', async () => {
    // Make databaseAdapter throw an error when accessed
    Object.defineProperty(mockRuntime, 'databaseAdapter', {
      get() {
        throw new Error('No adapter');
      },
      configurable: true,
    });

    (mockRuntime.getSetting as any).mockReturnValue(undefined);

    await plugin.init?.({}, mockRuntime);

    expect(mockRuntime.registerDatabaseAdapter).toHaveBeenCalled();
  });
});
