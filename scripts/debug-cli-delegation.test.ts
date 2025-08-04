import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { existsSync, statSync, readFileSync } from 'fs';
import path from 'path';

// Mock the bun-exec utilities
const mockBunExecInherit = mock();
const mockBunExec = mock();

// Mock fs functions
const mockExistsSync = mock();
const mockStatSync = mock();
const mockReadFileSync = mock();

// Mock modules
mock.module('../packages/cli/src/utils/bun-exec', () => ({
  bunExecInherit: mockBunExecInherit,
  bunExec: mockBunExec,
}));

mock.module('fs', () => ({
  existsSync: mockExistsSync,
  statSync: mockStatSync,
  readFileSync: mockReadFileSync,
}));

// Import the debug script module functions (we'll need to refactor the script to export functions)
// Since the current script is a standalone executable, we'll test it by running it as a subprocess
// For now, let's create a more testable version by extracting the key functions

describe('CLI Delegation Debug Tool', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalArgv: string[];
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let logOutput: string[];
  let errorOutput: string[];

  beforeEach(() => {
    // Save original state
    originalEnv = { ...process.env };
    originalArgv = [...process.argv];
    originalConsoleLog = console.log;
    originalConsoleError = console.error;

    // Create mock console functions to capture output
    logOutput = [];
    errorOutput = [];
    console.log = mock((...args: any[]) => {
      logOutput.push(args.join(' '));
    });
    console.error = mock((...args: any[]) => {
      errorOutput.push(args.join(' '));
    });

    // Reset mocks
    mockBunExecInherit.mockReset();
    mockBunExec.mockReset();
    mockExistsSync.mockReset();
    mockStatSync.mockReset();
    mockReadFileSync.mockReset();

    // Mock process.cwd
    jest.spyOn(process, 'cwd').mockReturnValue('/test/project');

    // Clear environment variables
    delete process.env.NODE_ENV;
    delete process.env.ELIZA_TEST_MODE;
    delete process.env.BUN_TEST;
    delete process.env.VITEST;
    delete process.env.JEST_WORKER_ID;
    delete process.env.npm_lifecycle_event;
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
  });

  afterEach(() => {
    // Restore original state
    process.env = originalEnv;
    process.argv = originalArgv;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;

    // Restore mocks
    jest.restoreAllMocks();
  });

  describe('Local CLI Detection', () => {
    it('should detect when local CLI exists', async () => {
      // Set up mocks
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({
        size: 1024,
        mtime: new Date('2024-01-01'),
      });
      process.argv = ['bun', 'debug-cli-delegation.ts'];

      // Import and run the debug script
      const { spawn } = await import('bun');
      const proc = spawn(['bun', 'scripts/debug-cli-delegation.ts'], {
        cwd: '/home/runner/work/eliza/eliza',
        env: { ...process.env, NODE_ENV: undefined },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(stdout).toContain('Local CLI exists: ✅');
      expect(stdout).toContain('node_modules/@elizaos/cli/dist/index.js');
    });

    it('should detect when local CLI does not exist', async () => {
      mockExistsSync.mockReturnValue(false);
      process.argv = ['bun', 'debug-cli-delegation.ts'];

      const { spawn } = await import('bun');
      const proc = spawn(['bun', 'scripts/debug-cli-delegation.ts'], {
        cwd: '/home/runner/work/eliza/eliza',
        env: { ...process.env, NODE_ENV: undefined },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(stdout).toContain('Local CLI exists: ❌');
    });
  });

  describe('Environment Variable Detection', () => {
    it('should detect problematic NODE_ENV=test', async () => {
      mockExistsSync.mockReturnValue(true);
      process.argv = ['bun', 'debug-cli-delegation.ts'];

      const { spawn } = await import('bun');
      const proc = spawn(['bun', 'scripts/debug-cli-delegation.ts'], {
        cwd: '/home/runner/work/eliza/eliza',
        env: { ...process.env, NODE_ENV: 'test' },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(stdout).toContain('NODE_ENV: test');
      expect(stdout).toContain('Test/CI environment detected');
    });

    it('should detect problematic ELIZA_TEST_MODE', async () => {
      mockExistsSync.mockReturnValue(true);
      process.argv = ['bun', 'debug-cli-delegation.ts'];

      const { spawn } = await import('bun');
      const proc = spawn(['bun', 'scripts/debug-cli-delegation.ts'], {
        cwd: '/home/runner/work/eliza/eliza',
        env: { ...process.env, ELIZA_TEST_MODE: 'true' },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(stdout).toContain('ELIZA_TEST_MODE: true');
      expect(stdout).toContain('Test/CI environment detected');
    });

    it('should detect CI environment', async () => {
      mockExistsSync.mockReturnValue(true);
      process.argv = ['bun', 'debug-cli-delegation.ts'];

      const { spawn } = await import('bun');
      const proc = spawn(['bun', 'scripts/debug-cli-delegation.ts'], {
        cwd: '/home/runner/work/eliza/eliza',
        env: { ...process.env, CI: 'true' },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(stdout).toContain('CI: true');
      expect(stdout).toContain('Test/CI environment detected');
    });
  });

  describe('Process Arguments Detection', () => {
    it('should detect test command', async () => {
      mockExistsSync.mockReturnValue(true);

      const { spawn } = await import('bun');
      const proc = spawn(['bun', 'scripts/debug-cli-delegation.ts', 'test'], {
        cwd: '/home/runner/work/eliza/eliza',
        env: { ...process.env, NODE_ENV: undefined },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(stdout).toContain('["test"]');
      expect(stdout).toContain('Problematic arguments');
    });

    it('should detect --test flag', async () => {
      mockExistsSync.mockReturnValue(true);

      const { spawn } = await import('bun');
      const proc = spawn(['bun', 'scripts/debug-cli-delegation.ts', '--test'], {
        cwd: '/home/runner/work/eliza/eliza',
        env: { ...process.env, NODE_ENV: undefined },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(stdout).toContain('["--test"]');
      expect(stdout).toContain('Problematic arguments');
    });

    it('should detect version commands', async () => {
      mockExistsSync.mockReturnValue(true);

      const { spawn } = await import('bun');
      const proc = spawn(['bun', 'scripts/debug-cli-delegation.ts', '--version'], {
        cwd: '/home/runner/work/eliza/eliza',
        env: { ...process.env, NODE_ENV: undefined },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(stdout).toContain('["--version"]');
      expect(stdout).toContain('Problematic arguments');
    });
  });

  describe('Package.json Analysis', () => {
    it('should analyze package.json correctly', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          name: '@test/project',
          type: 'module',
          dependencies: {
            '@elizaos/core': '^1.0.0',
          },
        })
      );

      const { spawn } = await import('bun');
      const proc = spawn(['bun', 'scripts/debug-cli-delegation.ts'], {
        cwd: '/home/runner/work/eliza/eliza',
        env: { ...process.env, NODE_ENV: undefined },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(stdout).toContain('Package name: @test/project');
      expect(stdout).toContain('Package type: module');
      expect(stdout).toContain('Has elizaos dependency: ✅');
    });

    it('should handle missing package.json', async () => {
      mockExistsSync.mockImplementation((filePath: string) => {
        if (filePath.includes('package.json')) return false;
        return true; // For CLI path
      });

      const { spawn } = await import('bun');
      const proc = spawn(['bun', 'scripts/debug-cli-delegation.ts'], {
        cwd: '/home/runner/work/eliza/eliza',
        env: { ...process.env, NODE_ENV: undefined },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(stdout).toContain('No package.json found');
    });

    it('should handle package.json read errors', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes('package.json')) {
          throw new Error('Permission denied');
        }
        return '{}';
      });

      const { spawn } = await import('bun');
      const proc = spawn(['bun', 'scripts/debug-cli-delegation.ts'], {
        cwd: '/home/runner/work/eliza/eliza',
        env: { ...process.env, NODE_ENV: undefined },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(stdout).toContain('Error reading package.json: Permission denied');
    });
  });

  describe('Help Display', () => {
    it('should display help with --help flag', async () => {
      const { spawn } = await import('bun');
      const proc = spawn(['bun', 'scripts/debug-cli-delegation.ts', '--help'], {
        cwd: '/home/runner/work/eliza/eliza',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(stdout).toContain('ElizaOS CLI Delegation Debug Tool');
      expect(stdout).toContain('Usage:');
      expect(stdout).toContain('--fix');
      expect(stdout).toContain('--help');
    });

    it('should display help with -h flag', async () => {
      const { spawn } = await import('bun');
      const proc = spawn(['bun', 'scripts/debug-cli-delegation.ts', '-h'], {
        cwd: '/home/runner/work/eliza/eliza',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(stdout).toContain('ElizaOS CLI Delegation Debug Tool');
      expect(stdout).toContain('Usage:');
    });
  });

  describe('Auto-fix Mode', () => {
    it('should attempt to install CLI when --fix is used', async () => {
      mockExistsSync.mockReturnValue(false); // No local CLI exists

      const { spawn } = await import('bun');
      const proc = spawn(['bun', 'scripts/debug-cli-delegation.ts', '--fix'], {
        cwd: '/home/runner/work/eliza/eliza',
        env: { ...process.env, NODE_ENV: undefined },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(stdout).toContain('Auto-Fix Mode');
      expect(stdout).toContain('Installing @elizaos/cli locally');
    });
  });

  describe('Delegation Analysis', () => {
    it('should report successful delegation when conditions are met', async () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({
        size: 1024,
        mtime: new Date('2024-01-01'),
      });

      const { spawn } = await import('bun');
      const proc = spawn(['bun', 'scripts/debug-cli-delegation.ts'], {
        cwd: '/home/runner/work/eliza/eliza',
        env: { ...process.env, NODE_ENV: undefined },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(stdout).toContain('Delegation Analysis');
      // Should succeed when local CLI exists and no problematic env vars/args
      expect(stdout).toContain('Delegation should SUCCEED');
    });

    it('should report delegation failure when no local CLI', async () => {
      mockExistsSync.mockReturnValue(false);

      const { spawn } = await import('bun');
      const proc = spawn(['bun', 'scripts/debug-cli-delegation.ts'], {
        cwd: '/home/runner/work/eliza/eliza',
        env: { ...process.env, NODE_ENV: undefined },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(stdout).toContain('Delegation would FAIL: No local CLI found');
    });
  });

  describe('Recommendations', () => {
    it('should recommend bun install when no local CLI', async () => {
      mockExistsSync.mockReturnValue(false);

      const { spawn } = await import('bun');
      const proc = spawn(['bun', 'scripts/debug-cli-delegation.ts'], {
        cwd: '/home/runner/work/eliza/eliza',
        env: { ...process.env, NODE_ENV: undefined },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(stdout).toContain('💡 Recommendations');
      expect(stdout).toContain('bun install @elizaos/cli');
    });

    it('should recommend clearing env vars when problematic ones detected', async () => {
      mockExistsSync.mockReturnValue(true);

      const { spawn } = await import('bun');
      const proc = spawn(['bun', 'scripts/debug-cli-delegation.ts'], {
        cwd: '/home/runner/work/eliza/eliza',
        env: { ...process.env, NODE_ENV: 'test' },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(stdout).toContain('Clear these environment variables');
      expect(stdout).toContain('unset');
    });
  });

  describe('Quick Test', () => {
    it('should show quick test when delegation should work', async () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({
        size: 1024,
        mtime: new Date('2024-01-01'),
      });

      const { spawn } = await import('bun');
      const proc = spawn(['bun', 'scripts/debug-cli-delegation.ts'], {
        cwd: '/home/runner/work/eliza/eliza',
        env: { ...process.env, NODE_ENV: undefined },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(stdout).toContain('🧪 Quick Test');
      expect(stdout).toContain('elizaos --help');
      expect(stdout).toContain('Using local @elizaos/cli installation');
    });
  });

  describe('Error Handling', () => {
    it('should handle file stat errors gracefully', async () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockImplementation(() => {
        throw new Error('File access denied');
      });

      const { spawn } = await import('bun');
      const proc = spawn(['bun', 'scripts/debug-cli-delegation.ts'], {
        cwd: '/home/runner/work/eliza/eliza',
        env: { ...process.env, NODE_ENV: undefined },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(stdout).toContain('Error reading file: File access denied');
    });
  });
});
