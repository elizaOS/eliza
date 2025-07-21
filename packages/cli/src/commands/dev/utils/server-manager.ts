import * as path from 'node:path';
import { bunExecInherit } from '@/src/utils/bun-exec';
import type { Subprocess } from 'bun';
import type { ServerProcess } from '../types';

/**
 * Server process state management
 */
interface ServerState {
  process: Subprocess | null;
  isRunning: boolean;
}

/**
 * Global server state
 */
let serverState: ServerState = {
  process: null,
  isRunning: false,
};

/**
 * Check if a local CLI exists and return its path
 */
async function getLocalCliPath(): Promise<string | null> {
  const localCliPath = path.join(
    process.cwd(),
    'node_modules',
    '@elizaos',
    'cli',
    'dist',
    'index.js'
  );

  try {
    const fs = await import('fs');
    return fs.existsSync(localCliPath) ? localCliPath : null;
  } catch {
    return null;
  }
}

/**
 * Set up environment with proper module resolution paths
 */
function setupEnvironment(): Record<string, string> {
  const env = { ...process.env };

  // Add local node_modules to NODE_PATH for proper module resolution
  const localModulesPath = path.join(process.cwd(), 'node_modules');
  if (env.NODE_PATH) {
    env.NODE_PATH = `${localModulesPath}${path.delimiter}${env.NODE_PATH}`;
  } else {
    env.NODE_PATH = localModulesPath;
  }

  // Add local .bin to PATH to prioritize local executables
  const localBinPath = path.join(process.cwd(), 'node_modules', '.bin');
  if (env.PATH) {
    env.PATH = `${localBinPath}${path.delimiter}${env.PATH}`;
  } else {
    env.PATH = localBinPath;
  }

  // Ensure color output
  env.FORCE_COLOR = '1';

  // Preserve ELIZA_TEST_MODE for test environments
  if (process.env.ELIZA_TEST_MODE) {
    env.ELIZA_TEST_MODE = process.env.ELIZA_TEST_MODE;
  }

  return env;
}

/**
 * Start the server process with the given arguments
 */
async function startServerProcess(args: string[] = []): Promise<void> {
  await stopServerProcess();

  console.info('Starting server...');

  const nodeExecutable = process.execPath;
  const localCliPath = await getLocalCliPath();

  let scriptPath: string;
  if (localCliPath) {
    console.info('Using local @elizaos/cli installation');
    scriptPath = localCliPath;
  } else {
    // Fallback to current script path (global CLI)
    scriptPath = process.argv[1];
  }

  const env = setupEnvironment();

  // Use Bun.spawn directly for better control
  // In test mode, use pipes to allow output capture
  const isTestMode = process.env.ELIZA_TEST_MODE === 'true';
  const commandArgs = [nodeExecutable, scriptPath, 'start', ...args];

  // In test mode, log the command being executed
  if (isTestMode) {
    console.info(`Executing command: ${commandArgs.join(' ')}`);
  }

  const childProcess = Bun.spawn(commandArgs, {
    stdio: isTestMode ? ['inherit', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit'],
    env,
    cwd: process.cwd(),
  });

  // Update server state
  serverState.process = childProcess;
  serverState.isRunning = true;

  // In test mode, pipe output to parent process
  if (isTestMode && childProcess.stdout && childProcess.stderr) {
    // Handle stdout piping
    childProcess.stdout
      .pipeTo(
        new WritableStream({
          write(chunk) {
            process.stdout.write(chunk);
            return Promise.resolve();
          },
        })
      )
      .catch((error) => {
        console.error('Error piping stdout:', error);
      });

    // Handle stderr piping
    childProcess.stderr
      .pipeTo(
        new WritableStream({
          write(chunk) {
            process.stderr.write(chunk);
            return Promise.resolve();
          },
        })
      )
      .catch((error) => {
        console.error('Error piping stderr:', error);
      });
  }

  // Handle process completion
  childProcess.exited
    .then((exitCode) => {
      if (exitCode !== 0) {
        console.warn(`Server process exited with code ${exitCode}`);
      } else {
        console.info('Server process exited normally');
      }

      // Reset state
      serverState.process = null;
      serverState.isRunning = false;
    })
    .catch((error) => {
      console.error(`Server process error: ${error.message}`);
      serverState.process = null;
      serverState.isRunning = false;
    });
}

/**
 * Stop the currently running server process
 */
async function stopServerProcess(): Promise<boolean> {
  if (!serverState.process || !serverState.isRunning) {
    return false;
  }

  console.info('Stopping current server process...');

  try {
    // Send SIGTERM to the process
    const killed = serverState.process.kill('SIGTERM');

    if (!killed) {
      console.warn('Failed to kill server process, trying force kill...');
      serverState.process.kill('SIGKILL');
    }

    // Reset state
    serverState.process = null;
    serverState.isRunning = false;

    // Give the process a moment to fully terminate
    await new Promise((resolve) => setTimeout(resolve, 500));

    return true;
  } catch (error) {
    console.error(`Error stopping server process: ${error}`);

    // Reset state even on error
    serverState.process = null;
    serverState.isRunning = false;

    return false;
  }
}

/**
 * Restart the server process
 */
async function restartServerProcess(args: string[] = []): Promise<void> {
  console.info('Restarting server...');
  await startServerProcess(args);
}

/**
 * Check if the server is currently running
 */
function isServerRunning(): boolean {
  return serverState.isRunning && serverState.process !== null;
}

/**
 * Get the current server process
 */
function getServerProcess(): Subprocess | null {
  return serverState.process;
}

/**
 * Server process manager implementation using functional patterns
 */
export const createServerManager = (): ServerProcess => ({
  async start(args: string[] = []): Promise<void> {
    return startServerProcess(args);
  },

  async stop(): Promise<boolean> {
    return stopServerProcess();
  },

  async restart(args: string[] = []): Promise<void> {
    return restartServerProcess(args);
  },

  get process(): Subprocess | null {
    return getServerProcess();
  },

  isRunning(): boolean {
    return isServerRunning();
  },
});

/**
 * Global server manager instance
 */
let serverManager: ServerProcess | null = null;

/**
 * Get the global server manager instance
 */
export function getServerManager(): ServerProcess {
  if (!serverManager) {
    serverManager = createServerManager();
  }
  return serverManager;
}

/**
 * Stop the server and cleanup
 * @returns true if a server was stopped, false if no server was running
 */
export async function stopServer(): Promise<boolean> {
  return stopServerProcess();
}

/**
 * Start the server with given arguments
 */
export async function startServer(args: string[] = []): Promise<void> {
  return startServerProcess(args);
}

/**
 * Restart the server with given arguments
 */
export async function restartServer(args: string[] = []): Promise<void> {
  return restartServerProcess(args);
}

/**
 * Check if the server is currently running
 */
export function isRunning(): boolean {
  return isServerRunning();
}

/**
 * Get the current server process
 */
export function getCurrentProcess(): Subprocess | null {
  return getServerProcess();
}

// Export functional interface for backwards compatibility
export interface DevServerManager extends ServerProcess {}

/**
 * Create a new server manager instance (factory function)
 * @deprecated Use createServerManager() instead
 */
export function DevServerManager(): ServerProcess {
  return createServerManager();
}
