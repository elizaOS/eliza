import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFile, mkdir } from 'fs/promises';
import {
  setupTestEnvironment,
  cleanupTestEnvironment,
  runCliCommand,
  expectCliCommandToFail,
  expectHelpOutput,
  type TestContext,
} from './test-utils';

describe('ElizaOS Monorepo Commands', () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await setupTestEnvironment();
  });

  afterEach(async () => {
    await cleanupTestEnvironment(context);
  });

  test('monorepo --help shows usage', () => {
    const result = runCliCommand(context.elizaosCmd, 'monorepo --help');
    expectHelpOutput(result, 'monorepo', ['-b', '--branch', '-d', '--dir']);
  });

  test('monorepo command works with help', () => {
    const result = runCliCommand(context.elizaosCmd, 'monorepo --help');
    expect(result).toContain('monorepo');
  });

  test('monorepo shows branch option', () => {
    const result = runCliCommand(context.elizaosCmd, 'monorepo --help');
    expect(result).toContain('--branch');
  });

  test('monorepo shows directory option', () => {
    const result = runCliCommand(context.elizaosCmd, 'monorepo --help');
    expect(result).toContain('--dir');
  });

  test('monorepo uses default branch and directory', () => {
    // This would try to clone, so we just test that it recognizes the command
    // without actually performing the network operation
    const result = runCliCommand(context.elizaosCmd, 'monorepo --help');
    expect(result).toContain('Branch to install');
    expect(result).toContain('develop'); // default branch
  });

  test('monorepo fails when directory is not empty', async () => {
    await mkdir('not-empty-dir');
    await writeFile('not-empty-dir/placeholder', '');

    const result = expectCliCommandToFail(context.elizaosCmd, 'monorepo --dir not-empty-dir', {
      timeout: 10000,
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/not empty/);
  });
});
