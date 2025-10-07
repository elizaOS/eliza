import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestEnvironment, cleanupTestEnvironment, type TestContext } from './test-utils';
import { bunExecSync } from '../utils/bun-test-helpers';

describe('ElizaOS Test Commands', () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await setupTestEnvironment();
  });

  afterEach(async () => {
    await cleanupTestEnvironment(context);
  });

  it('test --help shows usage', async () => {
    const result = bunExecSync('elizaos test --help', { encoding: 'utf8' });
    expect(result).toContain('Usage: elizaos test');
  });

  it('test command accepts -n option with quotes', async () => {
    const result = bunExecSync('elizaos test -n "filter-name" --help', { encoding: 'utf8' });
    expect(result).toContain('Filter tests by name');
  });

  it('test command accepts -n option without quotes', async () => {
    const result = bunExecSync('elizaos test -n filter-name --help', { encoding: 'utf8' });
    expect(result).toContain('Filter tests by name');
  });

  it('test command accepts --name option', async () => {
    const result = bunExecSync('elizaos test --name filter-name --help', { encoding: 'utf8' });
    expect(result).toContain('Filter tests by name');
  });

  it('test component command accepts -n option', async () => {
    const result = bunExecSync('elizaos test component -n filter-name --help', {
      encoding: 'utf8',
    });
    expect(result).toContain('component');
  });

  it('test e2e command accepts -n option', async () => {
    const result = bunExecSync('elizaos test e2e -n filter-name --help', { encoding: 'utf8' });
    expect(result).toContain('e2e');
  });

  it('test command accepts --skip-build option', async () => {
    const result = bunExecSync('elizaos test --skip-build --help', { encoding: 'utf8' });
    expect(result).toContain('Skip building before running tests');
  });

  it('test command accepts combination of options', async () => {
    const result = bunExecSync('elizaos test -n filter-name --skip-build --help', {
      encoding: 'utf8',
    });
    expect(result).toContain('Filter tests by name');
    expect(result).toContain('Skip building before running tests');
  });

  it('test command handles basic name format', async () => {
    const result = bunExecSync('elizaos test -n basic --help', { encoding: 'utf8' });
    expect(result).toContain('Usage: elizaos test');
  });

  it('test command handles .test name format', async () => {
    const result = bunExecSync('elizaos test -n basic.test --help', { encoding: 'utf8' });
    expect(result).toContain('Usage: elizaos test');
  });

  it('test command handles .test.ts name format', async () => {
    const result = bunExecSync('elizaos test -n basic.test.ts --help', { encoding: 'utf8' });
    expect(result).toContain('Usage: elizaos test');
  });
});
