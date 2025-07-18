import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { ServerProcess } from '../types';

/**
 * Server process manager for development mode
 *
 * Manages the lifecycle of the development server process, including starting, stopping, and restarting.
 */
export class DevServerManager implements ServerProcess {
  public process: ChildProcess | null = null;

  /**
   * Stops the currently running server process
   * @returns true if a server was stopped, false if no server was running
   */
  async stop(): Promise<boolean> {
    if (this.process) {
      console.info('Stopping current server process...');

      // Send SIGTERM to the process group
      const killed = this.process.kill('SIGTERM');
      if (!killed) {
        console.warn('Failed to kill server process, trying force kill...');
        this.process.kill('SIGKILL');
      }

      this.process = null;

      // Give the process a moment to fully terminate
      await new Promise((resolve) => setTimeout(resolve, 500));
      return true;
    }
    return false;
  }

  /**
   * Starts the server process with the given arguments
   */
  async start(args: string[] = []): Promise<void> {
    await this.stop();

    console.info('Starting server...');

    const nodeExecutable = process.execPath;

    // Check if a local CLI exists and use it instead of the global one
    const localCliPath = path.join(
      process.cwd(),
      'node_modules',
      '@elizaos',
      'cli',
      'dist',
      'index.js'
    );
    const fs = await import('fs');

    let scriptPath: string;
    if (fs.existsSync(localCliPath)) {
      console.info('Using local @elizaos/cli installation');
      scriptPath = localCliPath;
    } else {
      // Fallback to current script path (global CLI)
      scriptPath = process.argv[1];
    }

    // Set up environment with proper module resolution paths
    const env = { ...process.env };

    // Add local node_modules to NODE_PATH for proper module resolution
    // This ensures spawned process can find local packages
    const localModulesPath = path.join(process.cwd(), 'node_modules');
    if (env.NODE_PATH) {
      env.NODE_PATH = `${localModulesPath}${path.delimiter}${env.NODE_PATH}`;
    } else {
      env.NODE_PATH = localModulesPath;
    }

    // Add local .bin to PATH to prioritize local executables
    // This ensures local CLI tools are used over global ones
    const localBinPath = path.join(process.cwd(), 'node_modules', '.bin');
    if (env.PATH) {
      env.PATH = `${localBinPath}${path.delimiter}${env.PATH}`;
    } else {
      env.PATH = localBinPath;
    }

    // Ensure color output
    env.FORCE_COLOR = '1';

    // Use spawn to create a process
    this.process = spawn(nodeExecutable, [scriptPath, 'start', ...args], {
      stdio: 'inherit',
      detached: false, // We want to keep control of this process
      env: env,
      cwd: process.cwd(), // Ensure proper working directory
    });

    // Handle process exit events
    this.process.on('exit', (code, signal) => {
      if (code !== null) {
        if (code !== 0) {
          console.warn(`Server process exited with code ${code}`);
        } else {
          console.info('Server process exited normally');
        }
      } else if (signal) {
        console.info(`Server process was killed with signal ${signal}`);
      }
      this.process = null;
    });

    // Handle process errors
    this.process.on('error', (err) => {
      console.error(`Server process error: ${err.message}`);
      this.process = null;
    });
  }

  /**
   * Restarts the server process
   */
  async restart(args: string[] = []): Promise<void> {
    console.info('Restarting server...');
    await this.start(args);
  }
}

// Global server instance
let serverInstance: DevServerManager | null = null;

/**
 * Get the global server manager instance
 */
export function getServerManager(): DevServerManager {
  if (!serverInstance) {
    serverInstance = new DevServerManager();
  }
  return serverInstance;
}

/**
 * Stop the server and cleanup
 * @returns true if a server was stopped, false if no server was running
 */
export async function stopServer(): Promise<boolean> {
  const server = getServerManager();
  return await server.stop();
}

/**
 * Start the server with given arguments
 */
export async function startServer(args: string[] = []): Promise<void> {
  const server = getServerManager();
  await server.start(args);
}

/**
 * Restart the server with given arguments
 */
export async function restartServer(args: string[] = []): Promise<void> {
  const server = getServerManager();
  await server.restart(args);
}
