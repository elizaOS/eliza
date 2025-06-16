import { describe, it, expect, beforeEach, afterEach  } from 'vitest';
import {
  setupTestEnvironment,
  cleanupTestEnvironment,
  runCliCommand,
  expectHelpOutput,
  type TestContext,
} from './test-utils';

describe('ElizaOS Test Commands', () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await setupTestEnvironment();
  });

  afterEach(async () => {
    await cleanupTestEnvironment(context);
  });

  it('test --help shows usage', () => {
    const result = runCliCommand(context.elizaosCmd, 'test --help');
    expectHelpOutput(result, 'test');
  });

  it('test command accepts -n option with quotes', () => {
    const result = runCliCommand(context.elizaosCmd, `test -n "filter-name" --help`);
    expect(result).toContain('Filter tests by name');
  });

  it('test command accepts -n option without quotes', () => {
    const result = runCliCommand(context.elizaosCmd, 'test -n filter-name --help');
    expect(result).toContain('Filter tests by name');
  });

  it('test command accepts --name option', () => {
    const result = runCliCommand(context.elizaosCmd, 'test --name filter-name --help');
    expect(result).toContain('Filter tests by name');
  });

  it('test component command accepts -n option', () => {
    const result = runCliCommand(context.elizaosCmd, 'test component -n filter-name --help');
    expect(result).toContain('component');
  });

  it('test e2e command accepts -n option', () => {
    const result = runCliCommand(context.elizaosCmd, 'test e2e -n filter-name --help');
    expect(result).toContain('e2e');
  });

  it('test command accepts --skip-build option', () => {
    const result = runCliCommand(context.elizaosCmd, 'test --skip-build --help');
    expect(result).toContain('Skip building before running tests');
  });

  it('test command accepts combination of options', () => {
    const result = runCliCommand(context.elizaosCmd, 'test -n filter-name --skip-build --help');
    expect(result).toContain('Filter tests by name');
    expect(result).toContain('Skip building before running tests');
  });

  it('test command handles basic name format', () => {
    const result = runCliCommand(context.elizaosCmd, 'test -n basic --help');
    expectHelpOutput(result, 'test');
  });

  it('test command handles .test name format', () => {
    const result = runCliCommand(context.elizaosCmd, 'test -n basic.test --help');
    expectHelpOutput(result, 'test');
  });

  it('test command handles .test.ts name format', () => {
    const result = runCliCommand(context.elizaosCmd, 'test -n basic.test.ts --help');
    expectHelpOutput(result, 'test');
  });
});
