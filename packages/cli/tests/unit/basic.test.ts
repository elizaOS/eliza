import { describe, it, expect } from 'bun:test';

describe('Basic CLI Tests', () => {
  it('should run basic test', () => {
    expect(true).toBe(true);
  });

  it('should have process.env available', () => {
    expect(process.env).toBeDefined();
    expect(typeof process.env.NODE_ENV).toBe('string');
  });

  it('should be able to set environment variables', () => {
    process.env.TEST_VAR = 'test-value';
    expect(process.env.TEST_VAR).toBe('test-value');
  });
});
