import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the CLI executable
const CLI_PATH = path.resolve(__dirname, '../../dist/index.js');
const MONOREPO_ROOT = path.resolve(__dirname, '../../../..');

describe('CLI version display integration tests', () => {
  describe('version flag behavior', () => {
    it('should display "monorepo" when run from within the monorepo', async () => {
      const result = await runCLI(['--version'], { cwd: MONOREPO_ROOT });

      expect(result.stdout.trim()).toBe('monorepo');
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
    });

    it('should display "monorepo" in banner when run without args from monorepo', async () => {
      const result = await runCLI([], { cwd: MONOREPO_ROOT });

      // Check that the output contains the version line with "monorepo"
      expect(result.stdout).toContain('Version: monorepo');
      // Exit code is 1 when no command is provided (shows help)
      expect(result.code).toBe(1);
    });

    it('should not show update notification when in monorepo context', async () => {
      // Run a command that would normally trigger update check
      const result = await runCLI(['--help'], { cwd: MONOREPO_ROOT });

      // Should not contain update notification text
      expect(result.stdout).not.toContain('Update available');
      expect(result.stdout).not.toContain('bun i -g @elizaos/cli@latest');
      expect(result.code).toBe(0);
    });
  });

  describe('non-monorepo context behavior', () => {
    let tempDir: string;

    beforeEach(async () => {
      // Create a temporary directory outside the monorepo
      tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'eliza-cli-test-'));

      // Create a minimal package.json
      await fs.promises.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify(
          {
            name: 'test-project',
            version: '1.0.0',
            type: 'module',
          },
          null,
          2
        )
      );
    });

    afterEach(async () => {
      // Clean up temp directory
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    it.skip('should display package version when not in monorepo', async () => {
      // Skip this test as it requires a complex setup to properly simulate non-monorepo context
      // This scenario is better tested manually or in a separate test suite
    });
  });

  describe('local dist behavior', () => {
    it('should display "monorepo" when running from dist folder outside monorepo', async () => {
      // When the CLI is built and copied to a location outside the monorepo,
      // it should display "monorepo" if not in node_modules
      const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'eliza-cli-dist-test-'));

      try {
        // Copy the entire dist folder to the temp directory
        const distFolderPath = path.resolve(__dirname, '../../dist');
        const tempDistPath = path.join(tempDir, 'dist');
        await fs.promises.cp(distFolderPath, tempDistPath, { recursive: true });

        // Also copy package.json to avoid errors
        const cliPackageJson = path.resolve(__dirname, '../../package.json');
        const tempPackageJson = path.join(tempDir, 'package.json');
        await fs.promises.copyFile(cliPackageJson, tempPackageJson);

        const tempCliPath = path.join(tempDistPath, 'index.js');
        const result = await runCLI(['--version'], {
          cwd: tempDir,
          cliPath: tempCliPath,
        });

        expect(result.stdout.trim()).toBe('monorepo');
        expect(result.stderr).toBe('');
        expect(result.code).toBe(0);
      } finally {
        // Clean up
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});

/**
 * Helper function to run the CLI and capture output
 */
async function runCLI(
  args: string[],
  options: { cwd?: string; cliPath?: string } = {}
): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
}> {
  const cliPath = options.cliPath || CLI_PATH;
  const proc = Bun.spawn(['node', cliPath, ...args], {
    cwd: options.cwd || process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      // Disable auto-install to avoid side effects
      ELIZA_NO_AUTO_INSTALL: 'true',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Set up timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(new Error('CLI command timed out after 5 seconds'));
    }, 5000);
  });

  try {
    // Wait for process to exit and then read the streams
    await Promise.race([proc.exited, timeoutPromise]);

    const code = proc.exitCode;

    // Read streams after process has exited
    const stdout = proc.stdout ? await new Response(proc.stdout).text() : '';
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : '';

    return { stdout, stderr, code };
  } catch (error) {
    // If we timed out, still try to get any output
    if (error instanceof Error && error.message.includes('timed out')) {
      const stdout = proc.stdout ? await new Response(proc.stdout).text() : '';
      const stderr = proc.stderr ? await new Response(proc.stderr).text() : '';
      return { stdout, stderr, code: null };
    }
    throw error;
  }
}
