import { spawn, SpawnOptions } from 'child_process';
import { logger } from '@elizaos/core';

interface ExecuteOptions extends SpawnOptions {
  maxRetries?: number;
  retryDelay?: number;
  timeout?: number;
}

/**
 * Execute a command with retry logic and proper error handling
 */
export async function executeWithRetry(
  command: string,
  args: string[],
  options: ExecuteOptions = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  const { maxRetries = 1, retryDelay = 1000, timeout = 300000, ...spawnOptions } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      logger.info(`Retrying command (attempt ${attempt + 1}/${maxRetries + 1})...`);
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }

    try {
      const result = await executeCommand(command, args, { timeout, ...spawnOptions });
      return result;
    } catch (error) {
      lastError = error as Error;
      logger.debug(`Command failed on attempt ${attempt + 1}: ${error}`);
    }
  }

  throw lastError || new Error('Command failed after all retries');
}

/**
 * Execute a single command
 */
function executeCommand(
  command: string,
  args: string[],
  options: SpawnOptions & { timeout?: number }
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const { timeout = 300000, ...spawnOptions } = options;

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(command, args, {
      ...spawnOptions,
      stdio: spawnOptions.stdio || 'pipe',
    });

    // Set up timeout
    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 5000);
    }, timeout);

    if (child.stdout) {
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    child.on('close', (code) => {
      clearTimeout(timeoutId);

      if (timedOut) {
        reject(new Error(`Command timed out after ${timeout}ms`));
      } else if (code !== 0) {
        const error = new Error(`Command failed with exit code ${code}`);
        (error as any).code = code;
        (error as any).stdout = stdout;
        (error as any).stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr, code: code || 0 });
      }
    });

    child.on('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}

/**
 * Check if we're running under bun and need special handling
 */
export function isRunningUnderBun(): boolean {
  return (
    process.argv[0]?.includes('bun') ||
    process.execPath?.includes('bun') ||
    process.env.BUN_RUNTIME === '1'
  );
}
