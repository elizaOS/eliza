import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(spawn);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to run CLI commands
async function runCLI(
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const cliPath = path.join(__dirname, '../../dist/index.js');

  return new Promise((resolve) => {
    const child = spawn('node', [cliPath, ...args], {
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({
        exitCode: code || 0,
        stdout,
        stderr,
      });
    });
  });
}

describe('plugins generate command', () => {
  let testDir: string;
  let specFile: string;

  beforeEach(async () => {
    testDir = path.join(__dirname, `test-generate-${Date.now()}`);
    await fs.ensureDir(testDir);
    specFile = path.join(testDir, 'test-spec.json');

    // Set a mock API key
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(async () => {
    await fs.remove(testDir);
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should show help for generate command', async () => {
    const result = await runCLI(['plugins', 'generate', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Generate a new plugin using AI-powered code generation');
    expect(result.stdout).toContain('--spec-file');
    expect(result.stdout).toContain('--skip-tests');
    expect(result.stdout).toContain('--skip-validation');
    expect(result.stdout).toContain('--skip-prompts');
  });

  it('should require API key', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const result = await runCLI(['plugins', 'generate', '--skip-prompts']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('ANTHROPIC_API_KEY is required');
  });

  it('should require spec file when using --skip-prompts', async () => {
    const result = await runCLI(['plugins', 'generate', '--skip-prompts']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('--skip-prompts requires --spec-file to be provided');
  });

  it('should validate spec file exists', async () => {
    const result = await runCLI([
      'plugins',
      'generate',
      '--skip-prompts',
      '--spec-file',
      'non-existent.json',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Failed to read or parse spec file');
  });

  it('should validate spec file is valid JSON', async () => {
    // Create an invalid JSON file
    await fs.writeFile(specFile, 'invalid json content');

    const result = await runCLI(['plugins', 'generate', '--skip-prompts', '--spec-file', specFile]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Failed to read or parse spec file');
  });

  it(
    'should accept valid spec file',
    async () => {
      // Create a valid spec file
      const spec = {
        name: 'test-plugin',
        description: 'Test plugin for unit tests',
        features: ['Feature 1', 'Feature 2'],
        actions: ['testAction'],
        providers: ['testProvider'],
      };

      await fs.writeJSON(specFile, spec);

      const result = await runCLI([
        'plugins',
        'generate',
        '--skip-prompts',
        '--spec-file',
        specFile,
        '--skip-tests',
        '--skip-validation',
      ]);

      // Will fail with invalid API key but should get past spec validation
      expect(result.stdout).toContain('Starting AI-powered plugin generation');
      expect(result.exitCode).toBe(1); // Expected to fail due to invalid API key
      expect(result.stdout).toContain('invalid x-api-key');
    },
    { timeout: 20000 }
  );

  it(
    'should handle --api-key option',
    async () => {
      delete process.env.ANTHROPIC_API_KEY;

      const spec = {
        name: 'test-plugin',
        description: 'Test plugin',
        features: ['Test feature'],
      };

      await fs.writeJSON(specFile, spec);

      const result = await runCLI([
        'plugins',
        'generate',
        '--api-key',
        'test-api-key',
        '--skip-prompts',
        '--spec-file',
        specFile,
      ]);

      // Should not complain about missing API key
      expect(result.stdout).not.toContain('ANTHROPIC_API_KEY is required');
      // Will still fail with invalid API key
      expect(result.stdout).toContain('Starting AI-powered plugin generation');
    },
    { timeout: 20000 }
  );

  it(
    'should pass options to PluginCreator correctly',
    async () => {
      const spec = {
        name: 'test-plugin',
        description: 'Test plugin',
        features: ['Test feature'],
      };

      await fs.writeJSON(specFile, spec);

      // Test with all skip options
      const result = await runCLI([
        'plugins',
        'generate',
        '--skip-prompts',
        '--spec-file',
        specFile,
        '--skip-tests',
        '--skip-validation',
      ]);

      // The actual command will fail but we're testing that options are parsed
      expect(result.stdout).toContain('Starting AI-powered plugin generation');
      expect(result.exitCode).toBe(1); // Expected due to invalid API key
    },
    { timeout: 20000 }
  );
});
