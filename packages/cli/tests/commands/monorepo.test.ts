import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFile, mkdir } from 'fs/promises';
import {
  setupTestEnvironment,
  cleanupTestEnvironment,
  runCliCommand,
  expectCliCommandToFail,
  expectHelpOutput,
  type TestContext,
} from './test-utils';
import { TEST_TIMEOUTS } from '../test-timeouts';

describe('ElizaOS Monorepo Commands', () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await setupTestEnvironment();
  });

  afterEach(async () => {
    await cleanupTestEnvironment(context);
  });

  it('monorepo --help shows usage', () => {
    const result = runCliCommand(context.elizaosCmd, 'monorepo --help');
    expectHelpOutput(result, 'monorepo', ['-b', '--branch', '-d', '--dir']);
  });

  it('monorepo uses default branch and directory', () => {
    // This would try to clone, so we just test that it recognizes the command
    // without actually performing the network operation
    const result = runCliCommand(context.elizaosCmd, 'monorepo --help');
    expect(result).toContain('Branch to install');
    expect(result).toContain('develop'); // default branch
  });

  it('monorepo fails when directory is not empty', async () => {
    await mkdir('not-empty-dir');
    await writeFile('not-empty-dir/placeholder', '');

    const result = expectCliCommandToFail(context.elizaosCmd, 'monorepo --dir not-empty-dir', {
      timeout: TEST_TIMEOUTS.QUICK_COMMAND,
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/not empty/);
  });
});
