/**
 * Unit tests for Smithers database backend selection in plugin-workflow.
 *
 * The selection logic lives in `resolveSmithersDbConfig` (env → payload) and
 * the inline subprocess script (payload.dbConfig → Smithers layer). These tests
 * exercise:
 *   1. resolveSmithersDbConfig: valid backends and required connection details
 *   2. Subprocess layer selection fails instead of silently changing storage.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  buildSmithersWorkerEnv,
  resolveSmithersDbConfig,
  resolveSmithersDbPath,
  resolveSmithersTimeoutMs,
} from '../../src/services/smithers-runtime';

// ---------------------------------------------------------------------------
// resolveSmithersDbConfig
// ---------------------------------------------------------------------------

describe('resolveSmithersDbConfig', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore exact env state (delete keys added during the test).
    for (const key of ['SMITHERS_DB_PROVIDER', 'SMITHERS_DB_URL', 'SMITHERS_DB_DATA_DIR']) {
      if (key in savedEnv) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('defaults to sqlite when SMITHERS_DB_PROVIDER is unset', () => {
    delete process.env.SMITHERS_DB_PROVIDER;
    const config = resolveSmithersDbConfig();
    expect(config.provider).toBe('sqlite');
    expect(config.connectionString).toBeUndefined();
    expect(config.dataDir).toBeUndefined();
  });

  it('returns provider=sqlite when SMITHERS_DB_PROVIDER=sqlite', () => {
    process.env.SMITHERS_DB_PROVIDER = 'sqlite';
    const config = resolveSmithersDbConfig();
    expect(config.provider).toBe('sqlite');
  });

  it('returns provider=postgres and connectionString when SMITHERS_DB_PROVIDER=postgres', () => {
    process.env.SMITHERS_DB_PROVIDER = 'postgres';
    process.env.SMITHERS_DB_URL = 'postgresql://user:pass@localhost:5432/db';
    const config = resolveSmithersDbConfig();
    expect(config.provider).toBe('postgres');
    expect(config.connectionString).toBe('postgresql://user:pass@localhost:5432/db');
  });

  it('fails closed while Smithers PGlite packages require incompatible versions', () => {
    process.env.SMITHERS_DB_PROVIDER = 'pglite';
    process.env.SMITHERS_DB_DATA_DIR = '/tmp/pglite-data';
    expect(() => resolveSmithersDbConfig()).toThrow(
      'disabled until its engine and socket packages agree'
    );
  });

  it('rejects an unknown SMITHERS_DB_PROVIDER value', () => {
    process.env.SMITHERS_DB_PROVIDER = 'mysql';
    expect(() => resolveSmithersDbConfig()).toThrow('Unsupported Smithers database provider');
  });

  it('requires a connection string for postgres', () => {
    process.env.SMITHERS_DB_PROVIDER = 'postgres';
    delete process.env.SMITHERS_DB_URL;
    expect(() => resolveSmithersDbConfig()).toThrow('SMITHERS_DB_URL is required');
  });

  it('reports package incompatibility before accepting PGlite configuration', () => {
    process.env.SMITHERS_DB_PROVIDER = 'pglite';
    delete process.env.SMITHERS_DB_DATA_DIR;
    expect(() => resolveSmithersDbConfig()).toThrow(
      'disabled until its engine and socket packages agree'
    );
  });
});

describe('Smithers worker isolation', () => {
  it('uses separate durable SQLite files for identical workflow ids in different tenants', () => {
    const first = resolveSmithersDbPath('agent-one', 'shared-workflow');
    const second = resolveSmithersDbPath('agent-two', 'shared-workflow');

    expect(first).not.toBe(second);
    expect(first).toEndWith('/.eliza/smithers/agent-one/shared-workflow.sqlite');
    expect(second).toEndWith('/.eliza/smithers/agent-two/shared-workflow.sqlite');
    expect(() => resolveSmithersDbPath(' ', 'shared-workflow')).toThrow(
      'require an agent tenant id'
    );
  });

  it('does not forward provider credentials or workflow payloads through the environment', () => {
    const previousSecret = process.env.OPENAI_API_KEY;
    const previousPayload = process.env.ELIZA_SMITHERS_RUN_PAYLOAD;
    process.env.OPENAI_API_KEY = 'must-not-leak';
    process.env.ELIZA_SMITHERS_RUN_PAYLOAD = 'must-use-pipe';
    try {
      const env = buildSmithersWorkerEnv();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.ELIZA_SMITHERS_RUN_PAYLOAD).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.MSGPACKR_NATIVE_ACCELERATION_DISABLED).toBe('true');
    } finally {
      if (previousSecret === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousSecret;
      if (previousPayload === undefined) delete process.env.ELIZA_SMITHERS_RUN_PAYLOAD;
      else process.env.ELIZA_SMITHERS_RUN_PAYLOAD = previousPayload;
    }
  });

  it('rejects invalid execution timeouts', () => {
    expect(() => resolveSmithersTimeoutMs(0)).toThrow('positive number');
    expect(resolveSmithersTimeoutMs(1234)).toBe(1234);
  });
});

// ---------------------------------------------------------------------------
// Subprocess layer-selection logic (extracted and tested in isolation)
// ---------------------------------------------------------------------------

/**
 * Replicates the inline branch from createSmithersScript so we can unit-test
 * it without spawning a real subprocess. The logic is identical to what the
 * script string does:
 *
 *   const provider = dbConfig.provider ?? 'sqlite';
 *   sqlite → Smithers.sqlite; configured remote backends must exist or throw.
 */
function selectSmithersLayer(
  Smithers: Record<string, unknown>,
  dbConfig: { provider?: string; connectionString?: string; dataDir?: string },
  dbPath: string
): { method: string; arg: Record<string, unknown> } {
  const provider = dbConfig.provider ?? 'sqlite';
  if (provider === 'sqlite') return { method: 'sqlite', arg: { filename: dbPath } };
  if (provider === 'postgres' && typeof Smithers.postgres === 'function') {
    return { method: 'postgres', arg: { connectionString: dbConfig.connectionString } };
  }
  if (provider === 'pglite' && typeof Smithers.pglite === 'function') {
    return { method: 'pglite', arg: { dataDir: dbConfig.dataDir } };
  }
  throw new Error(`Configured Smithers backend is unavailable: ${provider}`);
}

describe('subprocess layer-selection logic', () => {
  const DB_PATH = '/tmp/workflow.sqlite';

  it('selects sqlite by default (empty dbConfig)', () => {
    const Smithers = { sqlite: () => 'sqlite-layer' };
    const result = selectSmithersLayer(Smithers, {}, DB_PATH);
    expect(result.method).toBe('sqlite');
    expect(result.arg).toEqual({ filename: DB_PATH });
  });

  it('selects sqlite when provider=sqlite', () => {
    const Smithers = { sqlite: () => 'sqlite-layer' };
    const result = selectSmithersLayer(Smithers, { provider: 'sqlite' }, DB_PATH);
    expect(result.method).toBe('sqlite');
    expect(result.arg).toEqual({ filename: DB_PATH });
  });

  it('selects postgres when provider=postgres and Smithers.postgres is a function', () => {
    const Smithers = {
      sqlite: () => 'sqlite-layer',
      postgres: () => 'postgres-layer',
    };
    const result = selectSmithersLayer(
      Smithers,
      { provider: 'postgres', connectionString: 'postgresql://localhost/db' },
      DB_PATH
    );
    expect(result.method).toBe('postgres');
    expect(result.arg).toEqual({ connectionString: 'postgresql://localhost/db' });
  });

  it('selects pglite when provider=pglite and Smithers.pglite is a function', () => {
    const Smithers = {
      sqlite: () => 'sqlite-layer',
      pglite: () => 'pglite-layer',
    };
    const result = selectSmithersLayer(
      Smithers,
      { provider: 'pglite', dataDir: '/tmp/pglite' },
      DB_PATH
    );
    expect(result.method).toBe('pglite');
    expect(result.arg).toEqual({ dataDir: '/tmp/pglite' });
  });

  it('fails when provider=postgres but Smithers.postgres is absent', () => {
    const Smithers = { sqlite: () => 'sqlite-layer' };
    expect(() =>
      selectSmithersLayer(
        Smithers,
        { provider: 'postgres', connectionString: 'postgresql://localhost/db' },
        DB_PATH
      )
    ).toThrow('Configured Smithers backend is unavailable');
  });

  it('fails when provider=pglite but Smithers.pglite is absent', () => {
    const Smithers = { sqlite: () => 'sqlite-layer' };
    expect(() =>
      selectSmithersLayer(Smithers, { provider: 'pglite', dataDir: '/tmp/pglite' }, DB_PATH)
    ).toThrow('Configured Smithers backend is unavailable');
  });
});
