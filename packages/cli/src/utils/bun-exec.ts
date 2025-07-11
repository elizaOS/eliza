import { type Subprocess } from 'bun';
import { logger } from '@elizaos/core';

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
 * @internal
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
  let proc: Subprocess<"pipe" | "inherit" | "ignore"> | null = null;
  let timeoutId: Timer | null = null;
  
  try {
    // Build the full command with proper escaping for logging
    const escapedArgs = args.map(escapeShellArg);
    const fullCommand = [command, ...escapedArgs].join(' ');

    logger.debug(`[bunExec] Executing: ${fullCommand}`);

    // Use Bun's shell functionality with proper options
    proc = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdout: options.stdout || options.stdio || 'pipe',
      stderr: options.stderr || options.stdio || 'pipe',
    });

    // Set up timeout if specified
    const timeoutPromise = new Promise<never>((_, reject) => {
      if (options.timeout && options.timeout > 0) {
        const timeoutMs = options.timeout;
        timeoutId = setTimeout(() => {
          if (proc) {
            proc.kill();
          }
          reject(new ProcessTimeoutError(
            `Command timed out after ${timeoutMs}ms`,
            fullCommand,
            timeoutMs
          ));
        }, timeoutMs);
      }
    });

    // Set up abort signal handling
    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        if (proc) {
          proc.kill();
        }
      });
    }

    // Collect output if piped
    let stdout = '';
    let stderr = '';

    // Handle stdout stream safely
    if (proc.stdout && typeof proc.stdout !== 'number' && options.stdout !== 'inherit' && options.stdio !== 'inherit') {
      try {
        const stdoutText = await Promise.race([
          new Response(proc.stdout).text(),
          timeoutPromise
        ]);
        stdout = stdoutText;
      } catch (error) {
        if (error instanceof ProcessTimeoutError) {
          throw error;
        }
        logger.debug('[bunExec] Error reading stdout:', error);
        // Continue execution even if stdout reading fails
      }
    }

    // Handle stderr stream safely
    if (proc.stderr && typeof proc.stderr !== 'number' && options.stderr !== 'inherit' && options.stdio !== 'inherit') {
      try {
        const stderrText = await Promise.race([
          new Response(proc.stderr).text(),
          timeoutPromise
        ]);
        stderr = stderrText;
      } catch (error) {
        if (error instanceof ProcessTimeoutError) {
          throw error;
        }
        logger.debug('[bunExec] Error reading stderr:', error);
        // Continue execution even if stderr reading fails
      }
    }

    // Wait for the process to complete with timeout
    const exitCode = await Promise.race([
      proc.exited,
      timeoutPromise
    ]) as number;

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
    
    logger.debug(`[bunExec] Error executing command: ${error}`);
    
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
    // Ensure process cleanup
    if (proc && proc.killed === false) {
      try {
        proc.kill();
      } catch (cleanupError) {
        logger.debug('[bunExec] Error during process cleanup:', cleanupError);
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
        timeout: 5000 // 5 second timeout for command existence check
      });
      return result.success;
    } else {
      const result = await bunExec('which', [command], { 
        stdio: 'ignore',
        timeout: 5000 // 5 second timeout for command existence check
      });
      return result.success;
    }
  } catch {
    return false;
  }
} 