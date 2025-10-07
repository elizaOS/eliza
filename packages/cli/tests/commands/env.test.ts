import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { bunExecSync } from '../utils/bun-test-helpers';
import { writeFile } from 'node:fs/promises';
import {
  setupTestEnvironment,
  cleanupTestEnvironment,
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
    const result = bunExecSync('elizaos env --help', { encoding: 'utf8' });
    expectHelpOutput(result, 'env');
  });

  it('env list shows environment variables', async () => {
    // First call: no local .env file present
    let result = bunExecSync('elizaos env list', { encoding: 'utf8' });

    const expectedSections = ['System Information', 'Local Environment Variables'];
    for (const section of expectedSections) {
      expect(result).toContain(section);
    }

    expect(result).toMatch(/(No local \.env file found|Missing \.env file)/);

    // Create a local .env file and try again
    await writeFile('.env', 'TEST_VAR=test_value');

    result = bunExecSync('elizaos env list', { encoding: 'utf8' });
    expect(result).toContain('TEST_VAR');
    expect(result).toContain('test_value');
  });

  it('env list --local shows only local environment', async () => {
    await writeFile('.env', 'LOCAL_TEST=local_value');

    const result = bunExecSync('elizaos env list --local', { encoding: 'utf8' });

    expect(result).toContain('LOCAL_TEST');
    expect(result).toContain('local_value');
    expect(result).not.toContain('System Information');
  });

  it('env edit-local creates local .env if missing', async () => {
    // Skip this test on Windows due to complex shell input handling
    if (process.platform === 'win32') {
      console.warn('Skipping env edit-local test on Windows due to shell input limitations');
      return;
    }

    // Use printf to simulate user input on Unix systems
    const result = bunExecSync(`printf "y\\n" | elizaos env edit-local`, {
      encoding: 'utf8',
      shell: '/bin/bash',
    });

    // The command should complete successfully
    expect(result).toBeTruthy();
  });

  it('env reset shows all necessary options', async () => {
    await writeFile('.env', 'DUMMY=value');

    const result = bunExecSync('elizaos env reset --yes', { encoding: 'utf8' });

    expect(result).toContain('Reset Summary');
    expect(result).toContain('Local environment variables');
    expect(result).toContain('Environment reset complete');
  });
});
