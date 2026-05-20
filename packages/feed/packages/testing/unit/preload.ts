/**
 * Preload file for unit tests
 *
 * This file is loaded before all unit tests to set up the test environment.
 * It mocks external dependencies like Redis connections.
 *
 * NOTE: Database (@feed/db) is NOT mocked here - tests should mock it themselves
 * because the db module has many exports that tests need to control individually.
 */

import { afterEach, beforeEach, mock } from 'bun:test';

// Set test environment
void Reflect.set(process.env, 'NODE_ENV', 'test');
void Reflect.set(process.env, 'BUN_ENV', 'test');
void Reflect.set(process.env, 'NEXT_PUBLIC_CURRENCY_SYMBOL', '$');

// Prevent file-local React module mocks from leaking across test files.
// React 19's react-dom performs a strict `react.version` check at runtime.
const actualReact = await import('react');

// Prevent file-local module mocks from leaking across test files.
// Many tests mock modules with incomplete stubs (missing logger, POINTS,
// DAILY_LOGIN, zod re-exports, etc.), which breaks unrelated tests that import
// the real module. Restoring after each test ensures a clean slate.
const actualShared = await import('@feed/shared');
const actualDb = await import('@feed/db');
const actualZod = await import('zod');

// These modules are also frequently mocked incompletely across test files.
// We use try/catch because they may have side effects on import, but capturing
// them here ensures we can restore them if they were mocked by a previous test.
let actualApi: Record<string, unknown> | null = null;
try {
  actualApi = await import('@feed/api');
} catch {
  // @feed/api may fail to import in some environments; skip restoration
}

let actualEngine: Record<string, unknown> | null = null;
try {
  actualEngine = await import('@feed/engine');
} catch {
  // @feed/engine may fail to import in some environments; skip restoration
}

let actualNextServer: Record<string, unknown> | null = null;
try {
  actualNextServer = await import('next/server');
} catch {
  // next/server may fail to import; skip restoration
}

function _restoreAllModules() {
  mock.module('react', () => ({
    ...actualReact,
    default: actualReact.default ?? actualReact,
  }));
  mock.module('@feed/shared', () => ({
    ...actualShared,
  }));
  mock.module('@feed/db', () => ({
    ...actualDb,
  }));
  mock.module('zod', () => ({
    ...actualZod,
  }));
  if (actualApi) {
    mock.module('@feed/api', () => ({
      ...actualApi,
    }));
  }
  if (actualEngine) {
    mock.module('@feed/engine', () => ({
      ...actualEngine,
    }));
  }
  if (actualNextServer) {
    mock.module('next/server', () => ({
      ...actualNextServer,
    }));
  }
}

// Only restore modules that DON'T typically need test-specific mocking.
// @feed/db, @feed/api, @feed/engine, next/server are commonly mocked
// with test-specific behavior (mock DB selects, mock auth, etc.) that must
// survive between tests. Only restore them in afterEach (after test completes).
function restoreSafeModules() {
  mock.module('react', () => ({
    ...actualReact,
    default: actualReact.default ?? actualReact,
  }));
  mock.module('@feed/shared', () => ({
    ...actualShared,
  }));
  mock.module('zod', () => ({
    ...actualZod,
  }));
  if (actualNextServer) {
    mock.module('next/server', () => ({
      ...actualNextServer,
    }));
  }
}

// Restore commonly-polluted modules between tests. We do NOT restore
// @feed/db, @feed/api, or @feed/engine here because:
// 1. Tests that mock them do so at the file top level for dynamic imports
// 2. Re-mocking them resets in-memory state (rate-limit Maps, session stores)
// 3. Tests that need the real modules capture them before their own mocks
beforeEach(restoreSafeModules);
afterEach(restoreSafeModules);

// Mock server-only so tests can import Next.js route handlers that use it
mock.module('server-only', () => ({}));

// Respect any CI/runner-provided DB connection string; otherwise default to local test DB.
process.env.DATABASE_URL ??=
  'postgresql://postgres:postgres@localhost:5432/test_db';
process.env.DIRECT_DATABASE_URL ??= process.env.DATABASE_URL;
process.env.REDIS_URL ??= 'redis://localhost:6379';

// Mock API keys to prevent initialization errors, but don’t override real keys if set.
process.env.GROQ_API_KEY ??= 'mock-groq-api-key-for-testing';
process.env.OPENAI_API_KEY ??= 'mock-openai-api-key-for-testing';

// Mock Redis/ioredis
mock.module('ioredis', () => {
  return {
    default: class MockRedis {
      constructor() {}
      on() {
        return this;
      }
      once() {
        return this;
      }
      removeListener() {
        return this;
      }
      removeAllListeners() {
        return this;
      }
      connect() {
        return Promise.resolve();
      }
      disconnect() {
        return Promise.resolve();
      }
      quit() {
        return Promise.resolve('OK');
      }
      get() {
        return Promise.resolve(null);
      }
      set() {
        return Promise.resolve('OK');
      }
      setex() {
        return Promise.resolve('OK');
      }
      del() {
        return Promise.resolve(1);
      }
      exists() {
        return Promise.resolve(0);
      }
      expire() {
        return Promise.resolve(1);
      }
      ttl() {
        return Promise.resolve(-1);
      }
      keys() {
        return Promise.resolve([]);
      }
      flushall() {
        return Promise.resolve('OK');
      }
      hget() {
        return Promise.resolve(null);
      }
      hset() {
        return Promise.resolve(1);
      }
      hdel() {
        return Promise.resolve(1);
      }
      hgetall() {
        return Promise.resolve({});
      }
      sadd() {
        return Promise.resolve(1);
      }
      srem() {
        return Promise.resolve(1);
      }
      smembers() {
        return Promise.resolve([]);
      }
      sismember() {
        return Promise.resolve(0);
      }
      zadd() {
        return Promise.resolve(1);
      }
      zrem() {
        return Promise.resolve(1);
      }
      zrange() {
        return Promise.resolve([]);
      }
      zrevrange() {
        return Promise.resolve([]);
      }
      pipeline() {
        const pipeline = {
          commands: [] as unknown[],
          get(key: string) {
            this.commands.push(['get', key]);
            return this;
          },
          set(key: string, value: unknown) {
            this.commands.push(['set', key, value]);
            return this;
          },
          del(key: string) {
            this.commands.push(['del', key]);
            return this;
          },
          exec() {
            return Promise.resolve(this.commands.map(() => [null, 'OK']));
          },
        };
        return pipeline;
      }
    },
  };
});

// Note: Logger is NOT mocked - it's a simple console wrapper with no side effects
// Keeping real logger helps debug failing tests

// Note: @feed/db is NOT mocked here - individual tests should mock it as needed
// This is because:
// 1. The db module has many named exports (tables, operators) that tests need
// 2. Tests may need to control mock return values differently
// 3. Mocking everything globally makes it hard to test specific behaviors

// Pre-import commonly used modules so they capture the real @feed/shared
// (including logger) before any test file's mock.module can pollute it.
// This is critical for modules like user-rate-limiter.ts that capture `logger`
// at module evaluation time via static `import { logger } from '@feed/shared'`.
try {
  await import('../../api/src/rate-limiting/user-rate-limiter');
} catch {
  // May fail if dependencies aren't available; that's OK
}
try {
  await import('../../api/src/rate-limiting/middleware');
} catch {
  // May fail if dependencies aren't available
}

console.log('Unit test environment initialized (Redis mocked, DB not mocked)');
