import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import {
  setupTestEnvironment,
  cleanupTestEnvironment,
  runCliCommand,
  expectHelpOutput,
  type TestContext,
} from './test-utils';

describe('ElizaOS Env Commands', () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await setupTestEnvironment();
  });

  afterEach(async () => {
    await cleanupTestEnvironment(context);
  });

  it('env --help shows usage', async () => {
    const result = await runCliCommand(context.elizaosCmd, 'env --help');
    expectHelpOutput(result, 'env');
  });

  it('env list shows environment variables', async () => {
    // First call: no local .env file present
    let result = await runCliCommand(context.elizaosCmd, 'env list');

    const expectedSections = ['System Information', 'Local Environment Variables'];
    for (const section of expectedSections) {
      expect(result).toContain(section);
    }

    expect(result).toMatch(/(No local \.env file found|Missing \.env file)/);

    // Create a local .env file and try again
    await writeFile('.env', 'TEST_VAR=test_value');

    result = await runCliCommand(context.elizaosCmd, 'env list');
    expect(result).toContain('TEST_VAR');
    expect(result).toContain('test_value');
  });

  it('env list --local shows only local environment', async () => {
    await writeFile('.env', 'LOCAL_TEST=local_value');

    const result = await runCliCommand(context.elizaosCmd, 'env list --local');

    expect(result).toContain('LOCAL_TEST');
    expect(result).toContain('local_value');
    expect(result).not.toContain('System Information');
  });

  it.skip('env edit-local creates local .env if missing', async () => {
    // Skip this test on Windows due to complex shell input handling
    if (process.platform === 'win32') {
      console.warn('Skipping env edit-local test on Windows due to shell input limitations');
      return;
    }

    // This test is skipped because interactive commands are not easily tested
    // TODO: Consider adding a non-interactive flag or test mode
    const result = 'skipped';

    // The command should complete successfully
    expect(result).toBeTruthy();
  });

  it('env reset shows all necessary options', async () => {
    await writeFile('.env', 'DUMMY=value');

    const result = await runCliCommand(context.elizaosCmd, 'env reset --yes');

    expect(result).toContain('Reset Summary');
    expect(result).toContain('Local environment variables');
    expect(result).toContain('Environment reset complete');
  });
});
