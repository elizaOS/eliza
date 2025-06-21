import { spawn, ChildProcess } from 'child_process';
import { logger } from '@elizaos/core';
import path from 'path';
import { existsSync } from 'fs';

export interface ServerOptions {
  port: number;
  projectPath: string;
  character?: any;
  plugins?: string[];
}

/**
 * Start a test server for running e2e tests
 */
export async function startTestServer(options: ServerOptions): Promise<ChildProcess> {
  const { port, projectPath } = options;
  // character and plugins are available in options for future use

  // Prepare environment variables
  const env = {
    ...process.env,
    PORT: port.toString(),
    NODE_ENV: 'test',
    ELIZA_TEST_MODE: 'true',
  };

  // Check if we should use the CLI start command or a custom server
  const packageJsonPath = path.join(projectPath, 'package.json');
  let startCommand = 'dev'; // Default to dev for plugins

  if (existsSync(packageJsonPath)) {
    const packageJson = require(packageJsonPath);

    // Check for test-specific start scripts
    if (packageJson.scripts) {
      if (packageJson.scripts['start:test']) {
        startCommand = 'start:test';
      } else if (packageJson.scripts['dev']) {
        // For plugins, prefer dev command which uses elizaos dev
        startCommand = 'dev';
      } else if (packageJson.scripts['start']) {
        startCommand = 'start';
      }
    }

    // For plugins, we typically want to use the dev command
    if (packageJson.packageType === 'plugin' && packageJson.scripts?.dev) {
      startCommand = 'dev';
    }
  }

  // Determine the package manager
  const hasYarnLock = existsSync(path.join(projectPath, 'yarn.lock'));
  const hasPnpmLock = existsSync(path.join(projectPath, 'pnpm-lock.yaml'));
  const hasBunLock = existsSync(path.join(projectPath, 'bun.lockb'));

  let packageManager = 'npm';
  if (hasBunLock) {
    packageManager = 'bun';
  } else if (hasYarnLock) {
    packageManager = 'yarn';
  } else if (hasPnpmLock) {
    packageManager = 'pnpm';
  }

  // Prepare the command arguments
  const args =
    packageManager === 'npm'
      ? ['run', startCommand]
      : packageManager === 'bun'
        ? ['run', startCommand]
        : [startCommand];

  // Add port argument if the command supports it
  // For elizaos dev/start commands, port is typically passed differently
  if (!startCommand.includes('dev') && !startCommand.includes('elizaos')) {
    args.push('--port', port.toString());
  }

  logger.info(`Starting server with: ${packageManager} ${args.join(' ')} in ${projectPath}`);

  // Spawn the server process
  const serverProcess = spawn(packageManager, args, {
    cwd: projectPath,
    env,
    stdio: 'pipe',
    shell: true,
    // Detached helps with process cleanup
    detached: process.platform !== 'win32',
  });

  // Handle server output
  serverProcess.stdout?.on('data', (data) => {
    const text = data.toString();
    text
      .split('\n')
      .filter((line: string) => line.trim())
      .forEach((line: string) => {
        logger.debug(`[Server] ${line}`);
      });
  });

  serverProcess.stderr?.on('data', (data) => {
    const text = data.toString();
    text
      .split('\n')
      .filter((line: string) => line.trim())
      .forEach((line: string) => {
        // Some servers log to stderr even for non-errors
        if (text.includes('error') || text.includes('Error')) {
          logger.error(`[Server Error] ${line}`);
        } else {
          logger.debug(`[Server] ${line}`);
        }
      });
  });

  serverProcess.on('error', (error) => {
    logger.error('Failed to start server:', error);
  });

  serverProcess.on('exit', (code, signal) => {
    if (code !== null) {
      logger.info(`Server exited with code ${code}`);
    } else if (signal) {
      logger.info(`Server killed with signal ${signal}`);
    }
  });

  return serverProcess;
}

/**
 * Stop a test server
 */
export async function stopTestServer(serverProcess: ChildProcess): Promise<void> {
  if (!serverProcess || serverProcess.killed) {
    return;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      logger.warn('Server did not stop gracefully, force killing...');
      serverProcess.kill('SIGKILL');
      resolve();
    }, 10000); // 10 second timeout

    serverProcess.on('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    serverProcess.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    // Try graceful shutdown first
    if (process.platform === 'win32') {
      serverProcess.kill('SIGTERM');
    } else {
      // On Unix-like systems, kill the process group
      if (serverProcess.pid) {
        try {
          process.kill(-serverProcess.pid, 'SIGTERM');
        } catch (error) {
          // If process group kill fails, fall back to killing just the process
          serverProcess.kill('SIGTERM');
        }
      }
    }
  });
}
