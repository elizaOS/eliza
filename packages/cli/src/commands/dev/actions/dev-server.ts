import { DevOptions } from '../types';
import { createDevContext, performInitialBuild, performRebuild } from '../utils/build-utils';
import { watchDirectory } from '../utils/file-watcher';
import { getServerManager } from '../utils/server-manager';
import { findNextAvailablePort } from '@/src/utils';
import { isPortFree } from '@/src/utils/port-handling';
import { ensureElizaOSCli } from '@/src/utils/dependency-manager';
import { logger } from '@elizaos/core';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Subprocess } from 'bun';
import chalk from 'chalk';

// Global reference to client dev server process
let clientDevServerProcess: Subprocess | null = null;

/**
 * (removed) hasClientPackage: no longer used
 */

/**
 * Determine if there is a local client source we can run in dev (Vite)
 * Excludes installed client in node_modules to avoid missing dev deps.
 */
function hasLocalClientSource(cwd: string): boolean {
  const monorepoClient = path.join(cwd, 'packages', 'client', 'package.json');
  const parentClient = path.join(path.dirname(cwd), 'client', 'package.json');
  const localViteTs = path.join(cwd, 'vite.config.ts');
  const localViteJs = path.join(cwd, 'vite.config.js');
  return (
    fs.existsSync(monorepoClient) ||
    fs.existsSync(parentClient) ||
    fs.existsSync(localViteTs) ||
    fs.existsSync(localViteJs)
  );
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
      // Fallback: if a local Vite config exists (standalone plugin demo UI), treat current dir as client
      // BUT: prevent recursive execution when running elizaos dev from the same directory
      if (!clientDir) {
        const localViteTs = path.join(cwd, 'vite.config.ts');
        const localViteJs = path.join(cwd, 'vite.config.js');
        if (fs.existsSync(localViteTs) || fs.existsSync(localViteJs)) {
          // Check if this would cause recursive execution
          const packageJsonPath = path.join(cwd, 'package.json');
          if (fs.existsSync(packageJsonPath)) {
            try {
              const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
              const devScript = packageJson.scripts?.['dev:client'] || packageJson.scripts?.['dev'];

              // If the dev script would run elizaos dev, skip to prevent recursion
              if (devScript && devScript.includes('elizaos dev')) {
                console.warn(
                  'Detected potential recursive elizaos dev execution in local Vite config. Skipping client dev server to prevent infinite loop.'
                );
                return;
              }
            } catch (error) {
              // If we can't parse package.json, err on the side of caution
              console.warn(
                'Could not parse package.json for recursive execution check. Skipping client dev server to be safe.'
              );
              return;
            }
          }
          clientDir = cwd;
        }
      }
    }
  }

  if (!clientDir) {
    console.warn('Client package not found, skipping client dev server');
    return;
  }

  // If the "client" is an installed dependency, don't try to run its dev server.
  // The installed package won't have dev dependencies available.
  const isInstalledClient = clientDir.includes(path.join('node_modules', '@elizaos', 'client'));
  if (isInstalledClient) {
    console.info(
      'Detected installed @elizaos/client. Using server static UI instead of running Vite.'
    );
    return;
  }

  console.info('Starting Vite dev server for client with HMR...');

  // Check if the client has a dev:client script
  const clientPackageJson = JSON.parse(
    fs.readFileSync(path.join(clientDir, 'package.json'), 'utf-8')
  );
  const hasDevClientScript = clientPackageJson.scripts?.['dev:client'];
  const hasDevScript = clientPackageJson.scripts?.['dev'];

  // Use dev:client if available, otherwise try dev
  const devScript = hasDevClientScript ? 'dev:client' : hasDevScript ? 'dev' : null;

  try {
    if (!devScript) {
      console.warn(
        'Client package does not have a dev:client or dev script, trying vite directly...'
      );
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
    console.error(
      `Failed to start client dev server: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`
    );
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
 * Wait until a TCP port is free (unbound) on the given host or until timeout.
 */
async function waitForPortToBeFree(
  port: number,
  host: string,
  timeoutMs: number = 15000
): Promise<void> {
  const start = Date.now();
  // Quick short-circuit
  if (await isPortFree(port, host)) return;

  while (Date.now() - start < timeoutMs) {
    // Small delay between checks
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (await isPortFree(port, host)) return;
  }
  // If still not free, proceed; the start step will re-check availability
}

/**
 * Get the client dev server port (from Vite config or default)
 */
async function getClientPort(cwd: string): Promise<number | null> {
  const possibleClientDirs = [
    cwd,
    path.join(cwd, 'packages', 'client'),
    path.join(path.dirname(cwd), 'client'),
    path.join(cwd, '..', 'client'),
    path.join(cwd, 'node_modules', '@elizaos', 'client'),
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
  const inStandalone = !isProject && !isPlugin && !isMonorepo;

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
      // Guard: if a rebuild is already pending, skip chaining restarts
      if ((rebuildAndRestart as any)._inFlight) {
        return;
      }
      (rebuildAndRestart as any)._inFlight = true;
      // Ensure the server is stopped first
      await serverManager.stop();

      // Also stop client dev server for clean restart
      const hasLocalVite =
        fs.existsSync(path.join(cwd, 'vite.config.ts')) ||
        fs.existsSync(path.join(cwd, 'vite.config.js'));
      const shouldStartClient =
        ((isProject || isMonorepo) && hasLocalClientSource(cwd)) || (isPlugin && hasLocalVite);
      if (shouldStartClient) {
        await stopClientDevServer();
      }

      // Perform rebuild
      await performRebuild(context);

      console.log('✓ Rebuild successful, restarting...');

      // Ensure previous port is free before starting to avoid port bumping
      await waitForPortToBeFree(serverPort, serverHost);

      // Start the server with the args
      await serverManager.start(cliArgs);

      // Restart client dev server if needed
      if (shouldStartClient) {
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
    } finally {
      (rebuildAndRestart as any)._inFlight = false;
    }
  };

  // Perform initial build if required
  if (isProject || isPlugin || isMonorepo) {
    const modeDescription = isMonorepo ? 'monorepo' : isProject ? 'project' : 'plugin';
    console.info(`Running in ${modeDescription} mode`);

    await performInitialBuild(context);
  }

  // Start the server initially (skip in standalone mode)
  let backendStarted = false;
  let serverPort = availablePort || 3000;
  if (!inStandalone) {
    if (process.env.ELIZA_TEST_MODE === 'true') {
      console.info(`[DEV] Starting server with args: ${cliArgs.join(' ')}`);
    }

    // Extract the actual port being used (after availability check)
    const portArgIndex = cliArgs.indexOf('--port');
    serverPort =
      portArgIndex !== -1 && cliArgs[portArgIndex + 1]
        ? parseInt(cliArgs[portArgIndex + 1], 10)
        : availablePort || 3000;

    await serverManager.start(cliArgs);
    backendStarted = true;

    // Give the server a moment to fully initialize
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } else if (process.env.ELIZA_TEST_MODE === 'true') {
    console.info('[DEV] Standalone mode detected, skipping backend server start');
  }

  // Start the client dev server if available (project/monorepo) or if a standalone plugin exposes a local Vite config
  const hasLocalVite =
    fs.existsSync(path.join(cwd, 'vite.config.ts')) ||
    fs.existsSync(path.join(cwd, 'vite.config.js'));
  const shouldStartClient =
    ((isProject || isMonorepo) && hasLocalClientSource(cwd)) || (isPlugin && hasLocalVite);
  if (shouldStartClient) {
    // Start the client dev server
    await startClientDevServer(cwd);

    // Give the client server a moment to start
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Display server information prominently
  console.info('\n' + '═'.repeat(60));
  if (backendStarted || clientDevServerProcess) {
    console.info('🚀 Development servers are running:');
  } else {
    console.info('🚀 Dev environment ready (standalone mode)');
  }
  console.info('═'.repeat(60));
  if (backendStarted) {
    console.info(`\n  Backend Server: ${chalk.cyan(`http://localhost:${serverPort}`)}`);
    console.info(`  API Endpoint:   ${chalk.cyan(`http://localhost:${serverPort}/api`)}`);
  }

  // Display client dev server info if it was started
  if (clientDevServerProcess) {
    const clientPort = await getClientPort(cwd);
    if (clientPort) {
      console.info(`  Client UI:      ${chalk.green(`http://localhost:${clientPort}`)}`);
    }
  } else {
    // If no client dev server is running but a static client is installed,
    // surface the Client UI URL to avoid confusion during development.
    try {
      const staticClientIndex = path.join(
        cwd,
        'node_modules',
        '@elizaos',
        'client',
        'dist',
        'index.html'
      );
      if (fs.existsSync(staticClientIndex) && backendStarted) {
        console.info(`  Client UI:      ${chalk.green(`http://localhost:${serverPort}`)} (static)`);
      }
    } catch {
      // noop
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
    // In standalone mode, no backend or file watching
    console.log('⚡ Running in standalone mode (no backend, no file watching)');
  }

  console.log('\nPress Ctrl+C to stop all servers');
  console.log('═'.repeat(60) + '\n');

  // Handle graceful shutdown - only register in non-test mode to avoid conflicts
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
