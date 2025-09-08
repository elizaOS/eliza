import { DevOptions } from '../types';
import { createDevContext, performInitialBuild, performRebuild } from '../utils/build-utils';
import { watchDirectory } from '../utils/file-watcher';
import { getServerManager } from '../utils/server-manager';
import { findNextAvailablePort } from '@/src/utils';
import { ensureElizaOSCli } from '@/src/utils/dependency-manager';
import { logger } from '@elizaos/core';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Subprocess } from 'bun';
import chalk from 'chalk';

// Global reference to client dev server process
let clientDevServerProcess: Subprocess | null = null;

/**
 * Check if client package exists in the monorepo or project
 */
function hasClientPackage(cwd: string): boolean {
  // Check for @elizaos/client in node_modules (installed dependency)
  const installedClientPath = path.join(cwd, 'node_modules', '@elizaos', 'client', 'package.json');
  
  // Check for client package in monorepo structure
  const monorepoClientPath = path.join(cwd, 'packages', 'client', 'package.json');
  
  // Check for client in parent directories (when running from within monorepo)
  const parentClientPath = path.join(path.dirname(cwd), 'client', 'package.json');
  
  return fs.existsSync(installedClientPath) || fs.existsSync(monorepoClientPath) || fs.existsSync(parentClientPath);
}

/**
 * Start the Vite development server for the client
 */
async function startClientDevServer(cwd: string): Promise<void> {
  // Stop any existing client dev server
  if (clientDevServerProcess) {
    console.info('Stopping existing client dev server...');
    clientDevServerProcess.kill();
    clientDevServerProcess = null;
  }

  // Determine the client directory
  let clientDir: string | null = null;
  
  // Check for client in monorepo packages
  const monorepoClientPath = path.join(cwd, 'packages', 'client');
  if (fs.existsSync(path.join(monorepoClientPath, 'package.json'))) {
    clientDir = monorepoClientPath;
  } else {
    // Check for client in parent directory (when running from within monorepo)
    const parentClientPath = path.join(path.dirname(cwd), 'client');
    if (fs.existsSync(path.join(parentClientPath, 'package.json'))) {
      clientDir = parentClientPath;
    } else {
      // Check for installed @elizaos/client
      const installedClientPath = path.join(cwd, 'node_modules', '@elizaos', 'client');
      if (fs.existsSync(path.join(installedClientPath, 'package.json'))) {
        clientDir = installedClientPath;
      }
    }
  }

  if (!clientDir) {
    console.warn('Client package not found, skipping client dev server');
    return;
  }

  console.info('Starting Vite dev server for client with HMR...');
  
  // Check if the client has a dev:client script
  const clientPackageJson = JSON.parse(fs.readFileSync(path.join(clientDir, 'package.json'), 'utf-8'));
  const hasDevClientScript = clientPackageJson.scripts?.['dev:client'];
  const hasDevScript = clientPackageJson.scripts?.['dev'];
  
  // Use dev:client if available, otherwise try dev
  const devScript = hasDevClientScript ? 'dev:client' : hasDevScript ? 'dev' : null;
  
  try {
    if (!devScript) {
      console.warn('Client package does not have a dev:client or dev script, trying vite directly...');
      // Try to run vite via bun x as fallback
      clientDevServerProcess = Bun.spawn(['bun', 'x', 'vite', '--host', '0.0.0.0'], {
        cwd: clientDir,
        stdio: ['inherit', 'pipe', 'pipe'],
        env: process.env,
      });
    } else {
      // Start the Vite dev server using the script
      clientDevServerProcess = Bun.spawn(['bun', 'run', devScript], {
        cwd: clientDir,
        stdio: ['inherit', 'pipe', 'pipe'],
        env: process.env,
      });
    }
  } catch (spawnError) {
    console.error(`Failed to start client dev server: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`);
    clientDevServerProcess = null;
    return;
  }

  // Handle process output to capture the actual URL
  const decoder = new TextDecoder();
  
  if (clientDevServerProcess.stdout) {
    const stdoutStream = clientDevServerProcess.stdout;
    if (typeof stdoutStream !== 'number') {
      (async () => {
        const reader = (stdoutStream as ReadableStream<Uint8Array>).getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              const text = decoder.decode(value);
              // Show Vite startup messages but filter noise
              if (
                text.includes('ready in') ||
                text.includes('Local:') ||
                text.includes('➜') ||
                text.includes('VITE')
              ) {
                process.stdout.write(text);
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      })();
    }
  }
  
  // Also handle stderr for errors
  if (clientDevServerProcess.stderr) {
    const stderrStream = clientDevServerProcess.stderr;
    if (typeof stderrStream !== 'number') {
      (async () => {
        const reader = (stderrStream as ReadableStream<Uint8Array>).getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              const text = decoder.decode(value);
              // Show errors and warnings
              if (text.trim()) {
                process.stderr.write(`[Client Error] ${text}`);
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      })();
    }
  }

  // Handle process exit
  clientDevServerProcess.exited
    .then((exitCode) => {
      if (exitCode !== 0) {
        console.error(`Client dev server exited with code ${exitCode}`);
      }
      clientDevServerProcess = null;
    })
    .catch((error) => {
      console.error(`Client dev server error: ${error.message}`);
      clientDevServerProcess = null;
    });

  // Wait a moment for the server to start
  await new Promise((resolve) => setTimeout(resolve, 2000));
  console.info('✓ Client dev server process started');
}

/**
 * Stop the client dev server
 */
async function stopClientDevServer(): Promise<void> {
  if (clientDevServerProcess) {
    console.info('Stopping client dev server...');
    clientDevServerProcess.kill();
    clientDevServerProcess = null;
    
    // Give it a moment to clean up
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Get the client dev server port (from Vite config or default)
 */
async function getClientPort(cwd: string): Promise<number | null> {
  const possibleClientDirs = [
    path.join(cwd, 'packages', 'client'),
    path.join(path.dirname(cwd), 'client'),
    path.join(cwd, '..', 'client')
  ];

  // 1) Check dev:client or dev script for --port flag
  for (const clientDir of possibleClientDirs) {
    const pkgPath = path.join(clientDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const script = pkg.scripts?.['dev:client'] || pkg.scripts?.['dev'];
        if (typeof script === 'string') {
          const match = script.match(/--port\s+(\d{2,5})/);
          if (match) {
            const port = parseInt(match[1], 10);
            if (!Number.isNaN(port)) return port;
          }
        }
      } catch {
        // ignore
      }
    }
  }

  // 2) Check vite.config.{ts,js} for server.port
  for (const clientDir of possibleClientDirs) {
    for (const cfg of ['vite.config.ts', 'vite.config.js']) {
      const viteConfigPath = path.join(clientDir, cfg);
      if (fs.existsSync(viteConfigPath)) {
        try {
          const content = fs.readFileSync(viteConfigPath, 'utf-8');
          const match = content.match(/server:\s*\{[\s\S]*?port:\s*(\d{2,5})/);
          if (match) {
            const port = parseInt(match[1], 10);
            if (!Number.isNaN(port)) return port;
          }
        } catch {
          // ignore
        }
      }
    }
  }

  // 3) Fallback default
  return 5173;
}

/**
 * Start development mode with file watching and auto-restart
 *
 * Sets up a development environment with automatic rebuilding and server restarting when files change.
 */
export async function startDevMode(options: DevOptions): Promise<void> {
  const cwd = process.cwd();

  // Auto-install @elizaos/cli as dev dependency using bun (for non-monorepo projects)
  await ensureElizaOSCli(cwd);

  const context = createDevContext(cwd);
  const serverManager = getServerManager();

  const { directoryType } = context;
  const isProject = directoryType.type === 'elizaos-project';
  const isPlugin = directoryType.type === 'elizaos-plugin';
  const isMonorepo = directoryType.type === 'elizaos-monorepo';

  // Log project type
  if (isProject) {
    console.info('Identified as an ElizaOS project package');
  } else if (isPlugin) {
    console.info('Identified as an ElizaOS plugin package');
  } else if (isMonorepo) {
    console.info('Identified as an ElizaOS monorepo');
  } else {
    console.warn(
      `Not in a recognized ElizaOS project, plugin, or monorepo directory. Current directory is: ${directoryType.type}. Running in standalone mode.`
    );
  }

  // Prepare CLI arguments for the start command
  const cliArgs: string[] = [];

  // Handle port availability checking
  let desiredPort: number;
  if (options.port !== undefined) {
    desiredPort = options.port;
  } else {
    const serverPort = process.env.SERVER_PORT;
    const parsedPort = serverPort ? Number.parseInt(serverPort, 10) : NaN;
    desiredPort = Number.isNaN(parsedPort) ? 3000 : parsedPort;
  }
  const serverHost = process.env.SERVER_HOST || '0.0.0.0';
  let availablePort: number;

  try {
    availablePort = await findNextAvailablePort(desiredPort, serverHost);

    if (availablePort !== desiredPort) {
      logger.warn(`Port ${desiredPort} is in use, using port ${availablePort} instead`);
    }
  } catch (error) {
    logger.error(
      `Failed to find available port starting from ${desiredPort}: ${error instanceof Error ? error.message : String(error)}`
    );
    logger.error('Please specify a different port using --port option');
    throw new Error(`No available ports found starting from ${desiredPort}`);
  }

  // Pass the available port to the start command
  cliArgs.push('--port', availablePort.toString());

  // Pass through configure option
  if (options.configure) {
    cliArgs.push('--configure');
  }

  // Handle characters - pass through to start command
  if (options.character) {
    if (Array.isArray(options.character)) {
      cliArgs.push('--character', ...options.character);
    } else {
      cliArgs.push('--character', options.character);
    }
  }

  // Function to rebuild and restart the server
  const rebuildAndRestart = async () => {
    try {
      // Ensure the server is stopped first
      await serverManager.stop();

      // Also stop client dev server for clean restart
      if ((isProject || isMonorepo) && hasClientPackage(cwd)) {
        await stopClientDevServer();
      }

      // Perform rebuild
      await performRebuild(context);

      console.log('✓ Rebuild successful, restarting...');

      // Start the server with the args
      await serverManager.start(cliArgs);
      
      // Restart client dev server if needed
      if ((isProject || isMonorepo) && hasClientPackage(cwd)) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await startClientDevServer(cwd);
      }
    } catch (error) {
      console.error(
        `Error during rebuild and restart: ${error instanceof Error ? error.message : String(error)}`
      );
      // Try to restart the server even if build fails
      if (!serverManager.process) {
        console.info('Attempting to restart server regardless of build failure...');
        await serverManager.start(cliArgs);
      }
    }
  };

  // Perform initial build if required
  if (isProject || isPlugin || isMonorepo) {
    const modeDescription = isMonorepo ? 'monorepo' : isProject ? 'project' : 'plugin';
    console.info(`Running in ${modeDescription} mode`);

    await performInitialBuild(context);
  }

  // Start the server initially
  if (process.env.ELIZA_TEST_MODE === 'true') {
    console.info(`[DEV] Starting server with args: ${cliArgs.join(' ')}`);
  }
  
  // Extract the actual port being used (after availability check)
  const portArgIndex = cliArgs.indexOf('--port');
  const serverPort = portArgIndex !== -1 && cliArgs[portArgIndex + 1] 
    ? parseInt(cliArgs[portArgIndex + 1], 10) 
    : availablePort || 3000;
    
  await serverManager.start(cliArgs);

  // Give the server a moment to fully initialize  
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Start the client dev server if available (for monorepo or projects with client)
  if ((isProject || isMonorepo) && hasClientPackage(cwd)) {
    // Start the client dev server
    await startClientDevServer(cwd);
    
    // Give the client server a moment to start
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Display server information prominently
  console.info('\n' + '═'.repeat(60));
  console.info('🚀 Development servers are running:');
  console.info('═'.repeat(60));
  console.info(`\n  Backend Server: ${chalk.cyan(`http://localhost:${serverPort}`)}`);
  console.info(`  API Endpoint:   ${chalk.cyan(`http://localhost:${serverPort}/api`)}`);
  
  // Display client dev server info if it was started
  if (clientDevServerProcess) {
    const clientPort = await getClientPort(cwd);
    if (clientPort) {
      console.info(`  Client UI:      ${chalk.green(`http://localhost:${clientPort}`)}`);
    }
  }
  
  console.info('\n' + '─'.repeat(60));
  
  // Set up file watching if we're in a project, plugin, or monorepo directory
  if (isProject || isPlugin || isMonorepo) {
    // Pass the rebuildAndRestart function as the onChange callback
    await watchDirectory(context.watchDirectory, rebuildAndRestart);

    console.log('📁 Watching for file changes...');
    console.log('🔄 The server will restart automatically when files change.');
  } else {
    // In standalone mode, just keep the server running without watching files
    console.log('⚡ Running in standalone mode (no file watching)');
  }
  
  console.log('\nPress Ctrl+C to stop all servers');
  console.log('═'.repeat(60) + '\n');

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.info('\nShutting down dev mode...');
    await stopClientDevServer();
    await serverManager.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.info('\nShutting down dev mode...');
    await stopClientDevServer();
    await serverManager.stop();
    process.exit(0);
  });
}
