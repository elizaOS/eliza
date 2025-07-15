/**
 * Centralized test utilities for ElizaOS CLI tests
 *
 * This module provides Bun-based replacements for Node.js child_process APIs
 * to ensure consistency with the project's Bun-first approach.
 *
 * @module bun-test-helpers
 */

import type { SpawnOptions } from 'bun';
import { join } from 'path';

/**
 * Options for bunExecSync function
 */
export interface BunExecSyncOptions {
  /** Working directory for the command */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Input/output behavior */
  stdio?: 'pipe' | 'inherit' | 'ignore';
  /** Encoding for output (default: 'utf8') */
  encoding?: 'utf8' | 'buffer';
  /** Timeout in milliseconds */
  timeout?: number;
  /** Maximum buffer size in bytes */
  maxBuffer?: number;
  /** Shell to use for command execution */
  shell?: boolean | string;
}

/**
 * Synchronous command execution using Bun.spawnSync
 * Drop-in replacement for Node.js execSync
 *
 * @param command - Command to execute (can include arguments)
 * @param options - Execution options
 * @returns Command output as string or Buffer
 * @throws Error if command fails or times out
 *
 * @example
 * ```typescript
 * // Simple command
 * const output = bunExecSync('git status');
 *
 * // With options
 * const result = bunExecSync('bun test', {
 *   cwd: '/path/to/project',
 *   env: { NODE_ENV: 'test' }
 * });
 * ```
 */
export function bunExecSync(command: string, options: BunExecSyncOptions = {}): string | Buffer {
  const {
    cwd = process.cwd(),
    env = process.env,
    stdio = 'pipe',
    encoding = 'utf8',
    timeout,
    maxBuffer = 1024 * 1024, // 1MB default
    shell = true,
  } = options;

  // Parse command into parts
  let args: string[];
  let cmd: string;

  if (shell) {
    // Use shell to execute command
    const shellCmd =
      typeof shell === 'string' ? shell : process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';

    // On Windows, cmd.exe has special quoting rules
    // If the command already contains quotes, we need to handle them carefully
    let shellArgs: string[];
    if (process.platform === 'win32') {
      // Windows cmd.exe: If command contains quotes, wrap entire command in quotes and escape internal quotes
      if (command.includes('"')) {
        // Don't add extra quotes if the command is already properly quoted
        shellArgs = ['/c', command];
      } else {
        shellArgs = ['/c', command];
      }
    } else {
      shellArgs = ['-c', command];
    }

    cmd = shellCmd;
    args = shellArgs;
  } else {
    // Parse command manually
    const parsed = parseCommand(command);
    cmd = parsed.command;
    args = parsed.args;
  }

  // Configure spawn options
  const spawnOptions: SpawnOptions.Sync = {
    cwd,
    env: env as Record<string, string | undefined>,
    stdout: stdio === 'inherit' ? 'inherit' : 'pipe',
    stderr: stdio === 'inherit' ? 'inherit' : 'pipe',
    stdin: stdio === 'inherit' ? 'inherit' : 'ignore',
  };

  // Execute command
  const proc = Bun.spawnSync([cmd, ...args], spawnOptions);

  // Handle timeout
  if (timeout && proc.exitCode === null) {
    throw new Error(`Command timed out: ${command}`);
  }

  // Handle errors
  if (proc.exitCode !== 0) {
    const error = new Error(`Command failed: ${command}\n${proc.stderr}`);
    const enhancedError = error as Error & {
      status: number | null;
      stderr: string;
      stdout: string;
    };
    enhancedError.status = proc.exitCode;
    enhancedError.stderr = proc.stderr;
    enhancedError.stdout = proc.stdout;
    throw error;
  }

  // Return output
  if (encoding === 'buffer') {
    return Buffer.from(proc.stdout);
  }

  return proc.stdout.toString();
}

/**
 * Wrapper for Bun.spawn with test-friendly defaults
 *
 * @param command - Command to execute
 * @param args - Command arguments
 * @param options - Spawn options
 * @returns Subprocess instance
 *
 * @example
 * ```typescript
 * // Spawn a long-running process
 * const proc = bunSpawn('bun', ['run', 'dev'], {
 *   cwd: projectDir,
 *   env: { PORT: '3000' }
 * });
 *
 * // Wait for process to complete
 * await proc.exited;
 * ```
 */
export function bunSpawn(
  command: string,
  args: string[] = [],
  options: Partial<SpawnOptions.OptionsObject> = {}
): ReturnType<typeof Bun.spawn> {
  const defaultOptions: SpawnOptions.OptionsObject = {
    cwd: process.cwd(),
    env: process.env as Record<string, string | undefined>,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
  };

  return Bun.spawn([command, ...args], {
    ...defaultOptions,
    ...options,
  });
}

/**
 * Run ElizaOS CLI command synchronously
 * Specialized helper for testing CLI commands
 *
 * @param args - CLI arguments (without 'elizaos' prefix)
 * @param options - Execution options
 * @returns Command output
 *
 * @example
 * ```typescript
 * // Test help command
 * const output = runCliCommandSync(['--help']);
 *
 * // Test with specific working directory
 * const result = runCliCommandSync(['start', '--non-interactive'], {
 *   cwd: testProjectDir
 * });
 * ```
 */
export function runCliCommandSync(args: string[], options: BunExecSyncOptions = {}): string {
  // Use global elizaos command
  const command = `elizaos ${args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')}`;

  return bunExecSync(command, options) as string;
}

/**
 * Parse command string into command and arguments
 * Handles quoted arguments properly
 *
 * @param commandString - Full command string
 * @returns Parsed command and arguments
 */
export function parseCommand(commandString: string): { command: string; args: string[] } {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < commandString.length; i++) {
    const char = commandString[i];

    if ((char === '"' || char === "'") && !inQuotes) {
      inQuotes = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuotes) {
      inQuotes = false;
      quoteChar = '';
    } else if (char === ' ' && !inQuotes) {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) {
    parts.push(current);
  }

  return {
    command: parts[0] || '',
    args: parts.slice(1),
  };
}

/**
 * Test helper to check if a command exists in PATH
 *
 * @param command - Command name to check
 * @returns True if command exists, false otherwise
 *
 * @example
 * ```typescript
 * if (commandExists('git')) {
 *   // Run git commands
 * }
 * ```
 */
export function commandExists(command: string): boolean {
  try {
    const result = bunExecSync(
      process.platform === 'win32' ? `where ${command}` : `which ${command}`,
      { stdio: 'pipe' }
    );
    return !!result && result.toString().trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Create a mock process for testing
 * Useful for mocking CLI commands in tests
 *
 * @param stdout - Stdout content
 * @param stderr - Stderr content
 * @param exitCode - Process exit code
 * @returns Mock process object
 *
 * @example
 * ```typescript
 * // Mock a successful command
 * const mockProc = createMockProcess('Success!', '', 0);
 *
 * // Mock a failed command
 * const mockError = createMockProcess('', 'Error occurred', 1);
 * ```
 */
export function createMockProcess(stdout: string = '', stderr: string = '', exitCode: number = 0) {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    exitCode,
    success: exitCode === 0,
    exited: Promise.resolve(exitCode),
  };
}

/**
 * Execute command and capture output with timeout
 *
 * @param command - Command to execute
 * @param timeoutMs - Timeout in milliseconds
 * @returns Command output or timeout error
 *
 * @example
 * ```typescript
 * try {
 *   const output = await execWithTimeout('bun test', 30000);
 *   console.log('Tests passed:', output);
 * } catch (error) {
 *   console.error('Tests failed or timed out');
 * }
 * ```
 */
export async function execWithTimeout(command: string, timeoutMs: number = 30000): Promise<string> {
  const proc = bunSpawn(...parseCommand(command).command.split(' '), {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const timeout = setTimeout(() => {
    proc.kill();
  }, timeoutMs);

  try {
    await proc.exited;
    clearTimeout(timeout);

    if (proc.exitCode !== 0) {
      throw new Error(`Command failed: ${command}\n${proc.stderr}`);
    }

    return await new Response(proc.stdout).text();
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

/**
 * Helper to run commands in a temporary directory
 *
 * @param callback - Function to execute in temp directory
 * @returns Result of callback
 *
 * @example
 * ```typescript
 * const result = await withTempDir(async (tmpDir) => {
 *   // Run commands in temp directory
 *   bunExecSync('bun init -y', { cwd: tmpDir });
 *   return bunExecSync('ls -la', { cwd: tmpDir });
 * });
 * ```
 */
export async function withTempDir<T>(callback: (tmpDir: string) => T | Promise<T>): Promise<T> {
  const tmpDir = await Bun.write(join(process.cwd(), '.tmp', `test-${Date.now()}`), '').then(() =>
    join(process.cwd(), '.tmp', `test-${Date.now()}`)
  );

  try {
    await Bun.write(join(tmpDir, '.gitkeep'), '');
    return await callback(tmpDir);
  } finally {
    // Cleanup
    try {
      await bunExecSync(`rm -rf "${tmpDir}"`);
    } catch {
      // Ignore cleanup errors
    }
  }
}
