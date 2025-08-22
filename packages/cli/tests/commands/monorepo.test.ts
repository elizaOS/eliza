import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFile, mkdir } from 'node:fs/promises';
import { bunExecSync } from '../utils/bun-test-helpers';
import {
  setupTestEnvironment,
  cleanupTestEnvironment,
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

  it('monorepo --help shows usage', async () => {
    const result = bunExecSync('elizaos monorepo --help', { encoding: 'utf8' });
    expectHelpOutput(result, 'monorepo', ['-b', '--branch', '-d', '--dir']);
  });

  it('monorepo uses default branch and directory', async () => {
    // This would try to clone, so we just test that it recognizes the command
    // without actually performing the network operation
    const result = bunExecSync('elizaos monorepo --help', { encoding: 'utf8' });
    expect(result).toContain('Branch to install');
    expect(result).toContain('develop'); // default branch
  });

  it('monorepo fails when directory is not empty', async () => {
    await mkdir('not-empty-dir');
    await writeFile('not-empty-dir/placeholder', '');

    try {
      // This should fail because directory is not empty
      bunExecSync('elizaos monorepo --dir not-empty-dir', { encoding: 'utf8' });
      // If we get here, the command succeeded when it shouldn't have
      throw new Error('Command should have failed but succeeded');
    } catch (e: any) {
      // Expected failure - command should fail when directory is not empty
      expect(e.message).toContain('Command failed');
    }
  });
});
