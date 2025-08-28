import { describe, it, expect } from 'bun:test';
import {
  detectEnvironment,
  getEnvironment,
  getEnv,
  setEnv,
  hasEnv,
  getBooleanEnv,
  getNumberEnv,
  initBrowserEnvironment,
} from '../environment';

describe('environment utils', () => {
  it('detects runtime (node in tests)', () => {
    const runtime = detectEnvironment();
    expect(['node', 'browser', 'unknown']).toContain(runtime);
  });

  it('gets and sets env vars via API', () => {
    const key = 'TEST_ENV_UTILS_KEY';
    setEnv(key, 'value1');
    expect(getEnv(key)).toBe('value1');
    expect(hasEnv(key)).toBe(true);
  });

  it('boolean env parsing works', () => {
    const key = 'TEST_BOOL_ENV';
    setEnv(key, 'true');
    expect(getBooleanEnv(key, false)).toBe(true);
    setEnv(key, '0');
    expect(getBooleanEnv(key, true)).toBe(false);
  });

  it('number env parsing works', () => {
    const key = 'TEST_NUM_ENV';
    setEnv(key, '42');
    expect(getNumberEnv(key)).toBe(42);
    setEnv(key, 'NaN');
    expect(getNumberEnv(key, 7)).toBe(7);
  });

  it('browser init helper is safe in node', () => {
    // Should not throw even though we are not in browser
    initBrowserEnvironment({ SOME_KEY: 'x' });
    expect(true).toBe(true);
  });

  it('environment cache can be cleared indirectly by creating a new instance', () => {
    const env = getEnvironment();
    // Access a key, then change it, ensure fresh read gets latest
    const key = 'TEST_CACHE_KEY';
    setEnv(key, 'a');
    expect(getEnv(key)).toBe('a');
    setEnv(key, 'b');
    // getEnv reads through the singleton which clears cache on set
    expect(getEnv(key)).toBe('b');
  });
});
