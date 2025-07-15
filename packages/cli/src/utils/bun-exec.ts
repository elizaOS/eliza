import { type Subprocess } from 'bun';
import { logger } from '@elizaos/core';

// Constants
const COMMAND_EXISTS_TIMEOUT_MS = 5000; // 5 seconds timeout for command existence checks

/**
 * Helper to ensure bun is in PATH for subprocess execution
 */
function ensureBunInPath(env: Record<string, string> = {}): Record<string, string> {
  const enhancedEnv = { ...process.env, ...env };

  if (enhancedEnv.PATH) {
    const pathSeparator = process.platform === 'win32' ? ';' : ':';
    const currentPaths = enhancedEnv.PATH.split(pathSeparator);

    // Add common bun installation paths if not already present
    const bunPaths = [
      process.env.HOME ? `${process.env.HOME}/.bun/bin` : null,
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ].filter(Boolean);

    for (const bunPath of bunPaths) {
      if (bunPath && !currentPaths.some((p) => p === bunPath || p.endsWith('/.bun/bin'))) {
        enhancedEnv.PATH = `${bunPath}${pathSeparator}${enhancedEnv.PATH}`;
      }
    }
  }

  return enhancedEnv;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  success: boolean;
}

export interface BunExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdio?: 'pipe' | 'inherit' | 'ignore';
  stdout?: 'pipe' | 'inherit';
  stderr?: 'pipe' | 'inherit';
  timeout?: number; // Add timeout support
  signal?: AbortSignal; // Add signal support for cancellation
}

// Define proper error types for better error handling
export class ProcessExecutionError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
    public readonly command: string
  ) {
    super(message);
    this.name = 'ProcessExecutionError';
  }
}

export class ProcessTimeoutError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly timeout: number
  ) {
    super(message);
    this.name = 'ProcessTimeoutError';
  }
}

/**
 * Properly escape shell arguments to prevent command injection
 * Uses JSON.stringify for robust escaping of special characters
 *
 * @param arg - The argument to escape
 * @returns The escaped argument
 *
 * @example
 * ```typescript
 * escapeShellArg('hello world') // => '"hello world"'
 * escapeShellArg('hello"world') // => '"hello\\"world"'
 * escapeShellArg('') // => '""'
 * ```
 */
function escapeShellArg(arg: string): string {
  // For empty strings, return quoted empty string
  if (arg === '') {
    return '""';
  }

  // Use JSON.stringify to handle all special characters including quotes,
  // backslashes, newlines, etc. Then remove the outer quotes that JSON adds
  const escaped = JSON.stringify(arg);
  return escaped;
}

/**
 * Helper to read a stream into a string
 */
async function readStreamSafe(
  stream: ReadableStream | number | null | undefined,
  streamName: string
): Promise<string> {
  if (!stream || typeof stream === 'number') {
    return '';
  }

  try {
    const text = await new Response(stream).text();
    return text;
  } catch (error) {
    logger.debug(`[bunExec] Error reading ${streamName}:`, error);
    return '';
  }
}

/**
 * Execute a command using Bun's shell functionality with enhanced security and error handling
 * This is a drop-in replacement for execa
 *
 * @param command - The command to execute
 * @param args - Array of arguments to pass to the command
 * @param options - Execution options including cwd, env, stdio, timeout, and signal
 * @returns Promise resolving to execution result with stdout, stderr, exitCode, and success
 *
 * @throws {ProcessExecutionError} When the command execution fails
 * @throws {ProcessTimeoutError} When the command times out
 *
 * @example
 * ```typescript
 * // Simple command execution
 * const result = await bunExec('echo', ['hello world']);
 * console.log(result.stdout); // "hello world"
 *
 * // With timeout
 * try {
 *   await bunExec('long-running-command', [], { timeout: 5000 });
 * } catch (error) {
 *   if (error instanceof ProcessTimeoutError) {
 *     console.log('Command timed out');
 *   }
 * }
 *
 * // With custom environment
 * await bunExec('npm', ['install'], {
 *   cwd: '/path/to/project',
 *   env: { NODE_ENV: 'production' }
 * });
 * ```
 */
export async function bunExec(
  command: string,
  args: string[] = [],
  options: BunExecOptions = {}
): Promise<ExecResult> {
  let proc: Subprocess<'pipe' | 'inherit' | 'ignore'> | null = null;
  let timeoutId: Timer | null = null;

  try {
    // Build the full command with proper escaping for logging
    const escapedArgs = args.map(escapeShellArg);
    const fullCommand = [command, ...escapedArgs].join(' ');

    logger.debug(`[bunExec] Executing: ${fullCommand}`);

    // Use Bun's shell functionality with proper options
    // Always ensure bun is in PATH for subprocess execution
    const enhancedEnv = ensureBunInPath(options.env);

    proc = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: enhancedEnv,
      stdout: options.stdout || options.stdio || 'pipe',
      stderr: options.stderr || options.stdio || 'pipe',
    });

    // Set up abort signal handling
    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        if (proc && proc.exitCode === null) {
          proc.kill();
        }
      });
    }

    // Create a promise that will reject on timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      if (options.timeout && options.timeout > 0) {
        const timeoutMs = options.timeout;
        timeoutId = setTimeout(() => {
          if (proc && proc.exitCode === null) {
            proc.kill();
          }
          reject(
            new ProcessTimeoutError(
              `Command timed out after ${timeoutMs}ms`,
              fullCommand,
              timeoutMs
            )
          );
        }, timeoutMs);
      }
    });

    // Read all streams and wait for exit concurrently
    const [stdout, stderr, exitCode] = await Promise.race([
      // Normal execution path - all operations run concurrently
      Promise.all([
        readStreamSafe(proc.stdout, 'stdout'),
        readStreamSafe(proc.stderr, 'stderr'),
        proc.exited,
      ]),
      // Timeout path
      timeoutPromise,
    ]);

    // Clear timeout if process completed successfully
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    const success = exitCode === 0;

    if (!success && options.stdio !== 'ignore') {
      logger.debug(`[bunExec] Command failed with exit code ${exitCode}`);
      if (stderr) {
        logger.debug(`[bunExec] stderr: ${stderr}`);
      }
    }

    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
      success,
    };
  } catch (error) {
    // Clear timeout on error
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    // Re-throw timeout errors as-is
    if (error instanceof ProcessTimeoutError) {
      throw error;
    }

    // Wrap other errors with more context
    if (error instanceof Error) {
      throw new ProcessExecutionError(
        `Command execution failed: ${error.message}`,
        null,
        '',
        command
      );
    }

    throw error;
  } finally {
    // Ensure process cleanup - only kill if process is still running
    if (proc && proc.exitCode === null) {
      try {
        proc.kill();
        logger.debug('[bunExec] Killed still-running process in cleanup');
      } catch (cleanupError) {
        // Process may have exited between our check and the kill attempt
        logger.debug(
          '[bunExec] Process cleanup error (process may have already exited):',
          cleanupError
        );
      }
    }
  }
}

/**
 * Execute a command and only return stdout (similar to execa's simple usage)
 * Throws an error if the command fails unless stdio is set to 'ignore'
 *
 * @param command - The command to execute
 * @param args - Array of arguments to pass to the command
 * @param options - Execution options
 * @returns Promise resolving to object with stdout property
 *
 * @throws {ProcessExecutionError} When the command fails (exitCode !== 0)
 *
 * @example
 * ```typescript
 * // Get command output
 * const { stdout } = await bunExecSimple('git', ['rev-parse', 'HEAD']);
 * console.log('Current commit:', stdout);
 *
 * // Ignore errors
 * const result = await bunExecSimple('which', ['optional-tool'], { stdio: 'ignore' });
 * ```
 */
export async function bunExecSimple(
  command: string,
  args: string[] = [],
  options: BunExecOptions = {}
): Promise<{ stdout: string }> {
  const result = await bunExec(command, args, options);
  if (!result.success && options.stdio !== 'ignore') {
    throw new ProcessExecutionError(
      `Command failed: ${command} ${args.map(escapeShellArg).join(' ')}`,
      result.exitCode,
      result.stderr,
      command
    );
  }
  return { stdout: result.stdout };
}

/**
 * Execute a command with inherited stdio (for interactive commands)
 * Useful for commands that need user interaction or should display output directly
 *
 * @param command - The command to execute
 * @param args - Array of arguments to pass to the command
 * @param options - Execution options (stdio will be overridden to 'inherit')
 * @returns Promise resolving to execution result
 *
 * @example
 * ```typescript
 * // Run interactive command
 * await bunExecInherit('npm', ['install']);
 *
 * // Run command that needs terminal colors
 * await bunExecInherit('npm', ['run', 'test']);
 * ```
 */
export async function bunExecInherit(
  command: string,
  args: string[] = [],
  options: BunExecOptions = {}
): Promise<ExecResult> {
  return bunExec(command, args, {
    ...options,
    stdio: 'inherit',
  });
}

/**
 * Check if a command exists in the system PATH
 * Uses 'which' on Unix-like systems and 'where' on Windows
 *
 * @param command - The command name to check
 * @returns Promise resolving to true if command exists, false otherwise
 *
 * @example
 * ```typescript
 * // Check if git is installed
 * if (await commandExists('git')) {
 *   console.log('Git is available');
 * } else {
 *   console.log('Git is not installed');
 * }
 *
 * // Check for optional tools
 * const hasDocker = await commandExists('docker');
 * const hasNode = await commandExists('node');
 * ```
 */
export async function commandExists(command: string): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const result = await bunExec('where', [command], {
        stdio: 'ignore',
        timeout: COMMAND_EXISTS_TIMEOUT_MS,
      });
      return result.success;
    } else {
      const result = await bunExec('which', [command], {
        stdio: 'ignore',
        timeout: COMMAND_EXISTS_TIMEOUT_MS,
      });
      return result.success;
    }
  } catch {
    return false;
  }
}
