#!/usr/bin/env bun

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const clientDir = path.resolve(__dirname, '../packages/client');
const cliDir = path.resolve(__dirname, '../packages/cli');

let processes = [];
let isShuttingDown = false;
let serverReady = false;

function log(prefix, message) {
  console.log(`[${prefix}] ${new Date().toLocaleTimeString()} - ${message}`);
}

// Simple color helpers (avoid external deps)
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

// Health check function to verify server is responding
async function waitForServer(url = 'http://localhost:3000/api/server/ping', maxAttempts = 30) {
  log('HEALTH', `Waiting for server to be ready at ${url}...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(2000), // 2 second timeout
      });
      if (response.ok) {
        log('HEALTH', `✅ Server is ready! (attempt ${attempt})`);
        return true;
      }
    } catch (error) {
      // Server not ready yet, continue waiting
      if (attempt % 5 === 0) {
        log('HEALTH', `Still waiting for server... (attempt ${attempt}/${maxAttempts})`);
      }
    }

    // Wait 1 second between attempts
    await new Promise((resolve) => setTimeout(resolve, 1000));

    if (isShuttingDown) {
      return false;
    }
  }

  log('HEALTH', `❌ Server failed to respond after ${maxAttempts} attempts`);
  return false;
}

function startViteDevServer() {
  log('CLIENT', 'Starting Vite dev server with HMR...');

  const child = spawn('bun', ['run', 'dev:client'], {
    cwd: clientDir,
    stdio: 'inherit',
    shell: true,
    detached: false,
  });

  child.on('close', (code, signal) => {
    if (!isShuttingDown) {
      log('CLIENT', `Vite dev server exited with code ${code} signal ${signal}`);
      if (code !== 0 && code !== null) {
        log('CLIENT', 'Vite dev server failed, shutting down...');
        cleanup('vite-error');
      }
    }
  });

  child.on('error', (error) => {
    if (!isShuttingDown) {
      log('CLIENT', `Vite dev server error: ${error.message}`);
      cleanup('vite-error');
    }
  });

  processes.push({ name: 'VITE-DEV', child, type: 'client' });
  return child;
}

function startCliServer() {
  log('CLI', 'Starting CLI server build...');

  // Run CLI build first, then start the server directly
  const child = spawn('bun', ['run', 'build'], {
    cwd: cliDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    detached: false,
  });

  child.stdout?.on('data', (data) => {
    if (!isShuttingDown) {
      process.stdout.write(`[CLI-BUILD] ${data}`);
    }
  });

  child.stderr?.on('data', (data) => {
    if (!isShuttingDown) {
      process.stderr.write(`[CLI-BUILD] ${data}`);
    }
  });

  child.on('close', async (code, signal) => {
    if (!isShuttingDown) {
      if (code === 0) {
        log('CLI', 'Build completed, starting server...');
        // Now start the actual CLI server
        const serverProcess = await startActualCliServer();
        if (serverProcess) {
          // Wait for server to be ready before starting frontend
          const port = process.env.SERVER_PORT || 3000;
          const url = `http://localhost:${port}/api/server/ping`;
          const ready = await waitForServer(url);

          if (ready && !isShuttingDown) {
            serverReady = true;
            log('DEV', '🔧 Backend server is ready!');
            startViteDevServer();
            log('DEV', '🚀 Development environment fully ready!');
            log('DEV', `📱 Frontend: ${cyan('http://localhost:5173')} (with HMR)`);
            log('DEV', `🔧 Backend API: ${cyan('http://localhost:3000')}`);
            log('DEV', '✨ All services are connected and ready!');
          } else if (!isShuttingDown) {
            log('CLI', 'Server failed to start properly, shutting down...');
            cleanup('server-health-check-failed');
          }
        }
      } else {
        log('CLI', `Build failed with code ${code} signal ${signal}`);
        cleanup('cli-build-error');
      }
    }
  });

  child.on('error', (error) => {
    if (!isShuttingDown) {
      log('CLI', `CLI build error: ${error.message}`);
      cleanup('cli-build-error');
    }
  });

  processes.push({ name: 'CLI-BUILD', child, type: 'build' });
  return child;
}

function startActualCliServer() {
  return new Promise((resolve) => {
    log('CLI', 'Starting CLI server process...');

    const child = spawn('bun', ['dist/index.js', 'start'], {
      cwd: cliDir,
      stdio: 'inherit',
      shell: false,
      detached: false,
      env: {
        ...process.env,
        NODE_ENV: 'development',
      },
    });

    child.on('close', (code, signal) => {
      if (!isShuttingDown) {
        log('CLI', `CLI server exited with code ${code} signal ${signal}`);
        if (code !== 0 && code !== null) {
          log('CLI', 'CLI server failed, shutting down...');
          cleanup('cli-error');
        }
      }
    });

    child.on('error', (error) => {
      if (!isShuttingDown) {
        log('CLI', `CLI server error: ${error.message}`);
        cleanup('cli-error');
        resolve(null);
      }
    });

    // Replace the build process with the server process
    const buildIndex = processes.findIndex((p) => p.name === 'CLI-BUILD');
    if (buildIndex !== -1) {
      processes[buildIndex] = { name: 'CLI-SERVER', child, type: 'server' };
    } else {
      processes.push({ name: 'CLI-SERVER', child, type: 'server' });
    }

    resolve(child);
  });
}

function cleanup(signal = 'SIGTERM') {
  if (isShuttingDown) return; // Prevent multiple cleanup calls
  isShuttingDown = true;

  log('DEV', `Received ${signal}, shutting down...`);

  if (processes.length === 0) {
    log('DEV', 'No processes to clean up, exiting...');
    process.exit(0);
    return;
  }

  // Kill all processes immediately and more aggressively
  const killPromises = processes.map(({ name, child, type }) => {
    return new Promise((resolve) => {
      if (child && !child.killed) {
        log('DEV', `Terminating ${name}...`);

        // Different timeout based on process type
        const timeout = type === 'server' ? 1000 : 500;

        // Set up a timeout for force kill
        const forceKillTimeout = setTimeout(() => {
          if (child && !child.killed) {
            log('DEV', `Force killing ${name}...`);
            try {
              child.kill('SIGKILL');
            } catch (error) {
              // Ignore errors during force kill
            }
          }
          resolve();
        }, timeout);

        // Listen for the process to exit
        child.on('exit', () => {
          clearTimeout(forceKillTimeout);
          log('DEV', `${name} stopped`);
          resolve();
        });

        // For CLI server, try SIGINT first (more graceful for Node.js apps)
        try {
          if (type === 'server') {
            child.kill('SIGINT');
          } else {
            child.kill('SIGTERM');
          }
        } catch (error) {
          // If graceful shutdown fails, try SIGKILL immediately
          try {
            child.kill('SIGKILL');
          } catch (killError) {
            // Process might already be dead
          }
          clearTimeout(forceKillTimeout);
          resolve();
        }
      } else {
        resolve();
      }
    });
  });

  // Wait for all processes to be killed (max 2 seconds total)
  Promise.allSettled(killPromises).then(() => {
    log('DEV', 'All processes terminated. Goodbye! 👋');
    process.exit(0);
  });

  // Force exit after 2 seconds if processes still running
  setTimeout(() => {
    log('DEV', 'Force exit - some processes may still be running');
    process.exit(1);
  }, 2000);
}

// Handle different termination signals more cleanly
process.on('SIGINT', () => cleanup('SIGINT (Ctrl+C)'));
process.on('SIGTERM', () => cleanup('SIGTERM'));
process.on('SIGHUP', () => cleanup('SIGHUP'));

// Handle unexpected exits
process.on('uncaughtException', (error) => {
  log('DEV', `Uncaught exception: ${error.message}`);
  cleanup('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  log('DEV', `Unhandled rejection: ${reason}`);
  cleanup('unhandledRejection');
});

async function main() {
  try {
    log('DEV', 'Starting development environment...');
    log('DEV', '🔧 Step 1: Building and starting backend server...');

    // Start CLI server first and wait for it to be ready
    startCliServer();

    // Frontend will be started automatically after server is ready
    log('DEV', 'Press Ctrl+C to stop all services.');
  } catch (error) {
    log('DEV', `Failed to start development environment: ${error.message}`);
    cleanup('startup-error');
  }
}

main();
