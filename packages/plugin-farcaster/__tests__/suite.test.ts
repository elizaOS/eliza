import { describe, expect, it } from 'vitest';
import { FarcasterTestSuite } from './suite';

describe('FarcasterTestSuite', () => {
  it('should initialize with the correct name and test functions', () => {
    const suite = new FarcasterTestSuite();

    expect(suite.name).toBe('farcaster');
    expect(suite.tests.length).toBeGreaterThan(0);
    expect(suite.tests[0].name).toBe('Initialize Farcaster Client');

    // Verify all test functions exist
    const testFunctions = suite.tests.map((test) => test.fn);
    expect(testFunctions.every((fn) => typeof fn === 'function')).toBe(true);
  });
});
