/**
 * Test fixtures and utilities for tool tests
 * Converted from tests/tools/conftest.py
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Create a temporary environment file for testing
 * Returns the path to the environment file and cleans up on test end
 */
export function withTmpEnvFile(): {
  envFile: string;
  tmpDir: string;
  cleanup: () => void;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-env-'));
  const envFile = path.join(tmpDir, '.swe-agent-env');

  // Create empty JSON env file
  fs.writeFileSync(envFile, '{}', 'utf-8');

  // Set environment variable
  const originalEnvFile = process.env.SWE_AGENT_ENV_FILE;
  process.env.SWE_AGENT_ENV_FILE = envFile;

  const cleanup = () => {
    // Restore original env
    if (originalEnvFile !== undefined) {
      process.env.SWE_AGENT_ENV_FILE = originalEnvFile;
    } else {
      delete process.env.SWE_AGENT_ENV_FILE;
    }

    // Clean up files
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };

  return { envFile, tmpDir, cleanup };
}

/**
 * Create a test file with content and set up registry
 */
export function createTestFileWithContent(
  envFile: string,
  content: string,
  fileName: string = 'test.py',
): { testPath: string; registry: Record<string, any> } {
  const tmpDir = path.dirname(envFile);
  const testPath = path.join(tmpDir, fileName);

  // Create test file
  fs.writeFileSync(testPath, content, 'utf-8');

  // Set up registry
  const registry = {
    CURRENT_FILE: testPath,
    FIRST_LINE: '1',
    WINDOW: '10',
  };

  fs.writeFileSync(envFile, JSON.stringify(registry), 'utf-8');

  return { testPath, registry };
}

/**
 * Mock for Python tool imports
 * Since we don't have Python tools in TypeScript tests, we need to mock them
 */
export function makePythonToolImportable(filePath: string, moduleName: string): void {
  // This is a no-op in TypeScript tests
  // Python tools would need to be converted to TypeScript first
  console.log(`Would import Python tool ${filePath} as ${moduleName} (mocked)`);
}
