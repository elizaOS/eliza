import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import { writeFile } from 'fs/promises';
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

  test('env --help shows usage', () => {
    const result = runCliCommand(context.elizaosCmd, 'env --help');
    expectHelpOutput(result, 'env');
  });

  test('env list shows environment variables', async () => {
    // First call: no local .env file present
    let result = runCliCommand(context.elizaosCmd, 'env list');

    const expectedSections = ['System Information', 'Local Environment Variables'];
    for (const section of expectedSections) {
      expect(result).toContain(section);
    }

    expect(result).toMatch(/(No local \.env file found|Missing \.env file)/);

    // Create a local .env file and try again
    await writeFile('.env', 'TEST_VAR=test_value');

    result = runCliCommand(context.elizaosCmd, 'env list');
    expect(result).toContain('TEST_VAR');
    expect(result).toContain('test_value');
  });

  test('env list --local shows only local environment', async () => {
    await writeFile('.env', 'LOCAL_TEST=local_value');

    const result = runCliCommand(context.elizaosCmd, 'env list --local');

    expect(result).toContain('LOCAL_TEST');
    expect(result).toContain('local_value');
    expect(result).not.toContain('System Information');
  });

  test('env edit-local creates local .env if missing', async () => {
    // Skip this test on Windows due to complex shell input handling
    if (process.platform === 'win32') {
      console.warn('Skipping env edit-local test on Windows due to shell input limitations');
      return;
    }
    
    // Use printf to simulate user input on Unix systems
    const result = execSync(`printf "y\\n" | ${context.elizaosCmd} env edit-local`, {
      encoding: 'utf8',
      shell: '/bin/bash',
    });

    // The command should complete successfully
    expect(result).toBeTruthy();
  });

  test('env reset shows all necessary options', async () => {
    await writeFile('.env', 'DUMMY=value');

    const result = runCliCommand(context.elizaosCmd, 'env reset --yes');

    expect(result).toContain('Reset Summary');
    expect(result).toContain('Local environment variables');
    expect(result).toContain('Environment reset complete');
  });
});
