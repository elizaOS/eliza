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
}

/**
 * Execute a command using Bun's shell functionality
 * This is a drop-in replacement for execa
 */
export async function bunExec(
  command: string,
  args: string[] = [],
  options: BunExecOptions = {}
): Promise<ExecResult> {
  try {
    // Build the full command
    const fullCommand = [command, ...args].map(arg => {
      // Escape arguments that contain spaces
      if (arg.includes(' ') && !arg.startsWith('"') && !arg.endsWith('"')) {
        return `"${arg}"`;
      }
      return arg;
    }).join(' ');

    logger.debug(`[bunExec] Executing: ${fullCommand}`);

    // Use Bun's shell functionality
    const proc = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdout: options.stdout || options.stdio || 'pipe',
      stderr: options.stderr || options.stdio || 'pipe',
    });

    // Collect output if piped
    let stdout = '';
    let stderr = '';

    if (proc.stdout && options.stdout !== 'inherit' && options.stdio !== 'inherit') {
      const stdoutText = await new Response(proc.stdout).text();
      stdout = stdoutText;
    }

    if (proc.stderr && options.stderr !== 'inherit' && options.stdio !== 'inherit') {
      const stderrText = await new Response(proc.stderr).text();
      stderr = stderrText;
    }

    // Wait for the process to complete
    const exitCode = await proc.exited;

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
    logger.debug(`[bunExec] Error executing command: ${error}`);
    throw error;
  }
}

/**
 * Execute a command and only return stdout (similar to execa's simple usage)
 */
export async function bunExecSimple(
  command: string,
  args: string[] = [],
  options: BunExecOptions = {}
): Promise<{ stdout: string }> {
  const result = await bunExec(command, args, options);
  if (!result.success && options.stdio !== 'ignore') {
    const error = new Error(`Command failed: ${command} ${args.join(' ')}`);
    (error as any).exitCode = result.exitCode;
    (error as any).stderr = result.stderr;
    throw error;
  }
  return { stdout: result.stdout };
}

/**
 * Execute a command with inherited stdio (for interactive commands)
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
 * Check if a command exists
 */
export async function commandExists(command: string): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const result = await bunExec('where', [command], { stdio: 'ignore' });
      return result.success;
    } else {
      const result = await bunExec('which', [command], { stdio: 'ignore' });
      return result.success;
    }
  } catch {
    return false;
  }
} 