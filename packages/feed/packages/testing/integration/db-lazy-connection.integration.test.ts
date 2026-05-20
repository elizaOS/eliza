import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { closeDatabase, db, dbRead, getDatabaseClientState } from '@babylon/db';
import {
  setupTestEnvironment,
  shouldSkipDatabaseTests,
} from '../helpers/setup';

const dbLazyDescribe = shouldSkipDatabaseTests() ? describe.skip : describe;

dbLazyDescribe('Lazy Connection Creation (Integration)', () => {
  let originalReplicaUrl: string | undefined;

  beforeAll(async () => {
    await setupTestEnvironment();
  });

  beforeEach(async () => {
    originalReplicaUrl = process.env.DATABASE_READ_REPLICA_URL;
    await closeDatabase();
  });

  afterEach(async () => {
    if (originalReplicaUrl === undefined) {
      delete process.env.DATABASE_READ_REPLICA_URL;
    } else {
      process.env.DATABASE_READ_REPLICA_URL = originalReplicaUrl;
    }
    await closeDatabase();
  });

  it('does not create the primary client on property access', () => {
    void db.user;

    const state = getDatabaseClientState();
    expect(state.hasPrimaryClient).toBe(false);
    expect(state.hasPrimaryDrizzle).toBe(false);
    expect(state.hasPrimaryProxy).toBe(false);
    expect(state.hasReadReplicaClient).toBe(false);
    expect(state.hasReadReplicaDrizzle).toBe(false);
    expect(state.hasReadReplicaProxy).toBe(false);
  });

  it('creates the primary client when a query executes', async () => {
    await db.user.findMany({ take: 1 });

    const state = getDatabaseClientState();
    expect(state.hasPrimaryClient).toBe(true);
    expect(state.hasPrimaryDrizzle).toBe(true);
    expect(state.hasPrimaryProxy).toBe(true);
    expect(state.hasReadReplicaClient).toBe(false);
    expect(state.hasReadReplicaDrizzle).toBe(false);
    expect(state.hasReadReplicaProxy).toBe(false);
  });

  it('eagerly falls back to the primary client for dbRead without a replica', () => {
    delete process.env.DATABASE_READ_REPLICA_URL;

    void dbRead.user;

    const state = getDatabaseClientState();
    expect(state.hasPrimaryClient).toBe(true);
    expect(state.hasPrimaryDrizzle).toBe(true);
    expect(state.hasPrimaryProxy).toBe(true);
    expect(state.hasReadReplicaClient).toBe(false);
    expect(state.hasReadReplicaDrizzle).toBe(false);
    expect(state.hasReadReplicaProxy).toBe(false);
  });

  it('uses the replica client for read-only queries when configured', async () => {
    expect(process.env.DATABASE_URL).toBeTruthy();

    process.env.DATABASE_READ_REPLICA_URL = process.env.DATABASE_URL;
    await closeDatabase();

    void dbRead.user;

    let state = getDatabaseClientState();
    expect(state.hasPrimaryClient).toBe(false);
    expect(state.hasPrimaryDrizzle).toBe(false);
    expect(state.hasPrimaryProxy).toBe(false);
    expect(state.hasReadReplicaClient).toBe(false);
    expect(state.hasReadReplicaDrizzle).toBe(false);

    await dbRead.user.findMany({ take: 1 });

    state = getDatabaseClientState();
    expect(state.hasPrimaryClient).toBe(false);
    expect(state.hasPrimaryDrizzle).toBe(false);
    expect(state.hasPrimaryProxy).toBe(false);
    expect(state.hasReadReplicaClient).toBe(true);
    expect(state.hasReadReplicaDrizzle).toBe(true);
    expect(state.hasReadReplicaProxy).toBe(true);
  });
});
