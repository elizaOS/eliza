#!/usr/bin/env bun

import path from 'path';
import { fileURLToPath } from 'url';
import { watch, existsSync } from 'node:fs';

/** @typedef {import('node:fs').FSWatcher} FSWatcher */
/** @typedef {import('bun').Subprocess} BunSubprocess */
/** @typedef {'build' | 'server' | 'client' | 'watcher'} ProcessType */
/** @typedef {{ name: string; child: BunSubprocess | FSWatcher; type: ProcessType }} ProcessInfo */

/** @type {string} */
const __filename = fileURLToPath(import.meta.url);
/** @type {string} */
const __dirname = path.dirname(__filename);

// Paths
/** @type {string} */
const clientDir = path.resolve(__dirname, '../packages/client');
/** @type {string} */
const cliDir = path.resolve(__dirname, '../packages/cli');
/** @type {string} */
const packagesDir = path.resolve(__dirname, '../packages');

// Source directories to watch for changes (packages that CLI depends on)
/** @type {string[]} */
const watchDirs = [
  path.resolve(packagesDir, 'cli/src'),
  path.resolve(packagesDir, 'core/src'),
  path.resolve(packagesDir, 'server/src'),
  path.resolve(packagesDir, 'api-client/src'),
  path.resolve(packagesDir, 'plugin-bootstrap/src'),
  path.resolve(packagesDir, 'plugin-sql/src'),
  path.resolve(packagesDir, 'config/src'),
];

/**
 * Extract the package name from a watched directory path, in a cross-platform way.
 *
 * Example: "/repo/packages/cli/src" -> "cli"
 * Example: "C:\\repo\\packages\\cli\\src" -> "cli"
 *
 * @param {string} dir
 * @returns {string}
 */
function getPackageNameFromDir(dir) {
  const normalizedDir = path.normalize(dir);
  const parts = normalizedDir.split(/[\\/]+/).filter(Boolean);

  const packagesIndex = parts.lastIndexOf('packages');
  if (packagesIndex !== -1 && parts.length > packagesIndex + 1) {
    return parts[packagesIndex + 1];
  }

  // Common case in this script: "<package>/src"
  if (parts.length >= 2 && parts[parts.length - 1] === 'src') {
    return parts[parts.length - 2];
  }

  return parts.length > 0 ? parts[parts.length - 1] : dir;
}

/** @type {ProcessInfo[]} */
let processes = [];
/** @type {boolean} */
let isShuttingDown = false;
/** @type {boolean} */
let serverReady = false;
/** @type {boolean} */
let isRebuilding = false;
/** @type {NodeJS.Timeout | null} */
let rebuildDebounceTimer = null;
/** @type {boolean} */
let rebuildQueued = false;

/**
 * Log a message with a prefix and timestamp
 * @param {string} prefix - The log prefix
 * @param {string} message - The message to log
 * @returns {void}
 */
function log(prefix, message) {
  console.log(`[${prefix}] ${new Date().toLocaleTimeString()} - ${message}`);
}

// Simple color helpers (avoid external deps)
/**
 * @param {string} s
 * @returns {string}
 */
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

/**
 * Health check function to verify server is responding
 * @param {string} [url='http://localhost:3000/api/server/ping'] - URL to check
 * @param {number} [maxAttempts=30] - Maximum number of attempts
 * @returns {Promise<boolean>}
 */
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

/**
 * Start the Vite development server for the frontend
 * @returns {BunSubprocess}
 */
function startViteDevServer() {
  log('CLIENT', 'Starting Vite dev server with HMR...');

  const child = Bun.spawn(['bun', 'run', 'dev:client'], {
    cwd: clientDir,
    stdio: ['inherit', 'inherit', 'inherit'],
    env: process.env,
  });

  // Monitor process exit
  child.exited
    .then((exitCode) => {
      if (!isShuttingDown) {
        log('CLIENT', `Vite dev server exited with code ${exitCode}`);
        if (exitCode !== 0) {
          log('CLIENT', 'Vite dev server failed, shutting down...');
          cleanup('vite-error');
        }
      }
    })
    .catch((error) => {
      if (!isShuttingDown) {
        log('CLIENT', `Vite dev server error: ${error.message}`);
        cleanup('vite-error');
      }
    });

  processes.push({ name: 'VITE-DEV', child, type: 'client' });
  return child;
}

/**
 * Start the CLI server by building and running it
 * @returns {BunSubprocess}
 */
function startCliServer() {
  log('CLI', 'Starting CLI server build...');

  // Run CLI build first, then start the server directly
  const child = Bun.spawn(['bun', 'run', 'build'], {
    cwd: cliDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  /** @type {string} */
  let stdoutData = '';
  /** @type {string} */
  let stderrData = '';

  // Read stdout
  (async () => {
    if (child.stdout) {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          stdoutData += text;
          if (!isShuttingDown) {
            process.stdout.write(`[CLI-BUILD] ${text}`);
          }
        }
      } catch (error) {
        // Stream ended
      }
    }
  })();

  // Read stderr
  (async () => {
    if (child.stderr) {
      const reader = child.stderr.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          stderrData += text;
          if (!isShuttingDown) {
            process.stderr.write(`[CLI-BUILD] ${text}`);
          }
        }
      } catch (error) {
        // Stream ended
      }
    }
  })();

  child.exited
    .then(async (exitCode) => {
      if (!isShuttingDown) {
        if (exitCode === 0) {
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
              startFileWatcher();
              log('DEV', '🚀 Development environment fully ready!');
              log('DEV', `📱 Frontend: ${cyan('http://localhost:5173')} (with HMR)`);
              log('DEV', `🔧 Backend API: ${cyan('http://localhost:3000')}`);
              log('DEV', '✨ All services are connected and ready!');
              log('DEV', '🔄 Hot reload enabled for backend code changes');
            } else if (!isShuttingDown) {
              log('CLI', 'Server failed to start properly, shutting down...');
              cleanup('server-health-check-failed');
            }
          } else if (!isShuttingDown) {
            log('CLI', 'Failed to spawn server process, shutting down...');
            cleanup('server-spawn-failed');
          }
        } else {
          log('CLI', `Build failed with code ${exitCode}`);
          cleanup('cli-build-error');
        }
      }
    })
    .catch((error) => {
      if (!isShuttingDown) {
        log('CLI', `CLI build error: ${error.message}`);
        cleanup('cli-build-error');
      }
    });

  processes.push({ name: 'CLI-BUILD', child, type: 'build' });
  return child;
}

/**
 * Start the actual CLI server process
 * @returns {Promise<BunSubprocess | null>} Returns the subprocess on success, null if spawn fails
 */
function startActualCliServer() {
  return new Promise((resolve) => {
    log('CLI', 'Starting CLI server process...');

    /** @type {BunSubprocess} */
    let child;
    try {
      child = Bun.spawn(['bun', 'dist/index.js', 'start'], {
        cwd: cliDir,
        stdio: ['inherit', 'inherit', 'inherit'],
        env: {
          ...process.env,
          NODE_ENV: 'development',
        },
      });
    } catch (error) {
      log('CLI', `Failed to spawn CLI server: ${error.message}`);
      resolve(null);
      return;
    }

    child.exited
      .then((exitCode) => {
        if (!isShuttingDown && !isRebuilding) {
          log('CLI', `CLI server exited with code ${exitCode}`);
          if (exitCode !== 0) {
            log('CLI', 'CLI server failed, shutting down...');
            cleanup('cli-error');
          }
        }
      })
      .catch((error) => {
        if (!isShuttingDown && !isRebuilding) {
          log('CLI', `CLI server error: ${error.message}`);
          cleanup('cli-error');
          // NOTE: We don't resolve(null) here because the Promise is already resolved
          // with `child` below. Async errors after process spawn are handled via cleanup().
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

/**
 * Rebuild and restart the server
 * @returns {Promise<void>}
 */
async function rebuildAndRestartServer() {
  // If already rebuilding, queue another rebuild for after this one completes
  if (isRebuilding) {
    rebuildQueued = true;
    return;
  }

  if (isShuttingDown) return;

  isRebuilding = true;
  rebuildQueued = false;

  try {
    log('REBUILD', '🔄 Rebuilding CLI...');

    // Stop the current server process
    const serverProcessIndex = processes.findIndex((p) => p.name === 'CLI-SERVER');
    if (serverProcessIndex !== -1) {
      const { child } = processes[serverProcessIndex];
      if (child && 'kill' in child) {
        log('REBUILD', 'Stopping server...');

        // Use exit event to properly track process termination
        const killPromise = new Promise((resolve) => {
          // Set up timeout for force kill
          const forceKillTimeout = setTimeout(() => {
            if (child.exitCode === null) {
              log('REBUILD', 'Server did not stop gracefully, force killing...');
              try {
                child.kill('SIGKILL');
              } catch (error) {
                // Ignore errors during force kill
              }
            }
            resolve(true); // Always resolve after timeout
          }, 500);

          // Listen for the process to exit
          child.exited
            .then(() => {
              clearTimeout(forceKillTimeout);
              log('REBUILD', 'Server stopped gracefully');
              resolve(true);
            })
            .catch(() => {
              // Handle rejection from child.exited
              clearTimeout(forceKillTimeout);
              resolve(true);
            });

          // Try graceful shutdown first
          try {
            child.kill('SIGTERM');
          } catch (error) {
            // If kill fails, try SIGKILL immediately
            try {
              child.kill('SIGKILL');
            } catch (killError) {
              // Process might already be dead
            }
            clearTimeout(forceKillTimeout);
            resolve(true);
          }
        });

        await killPromise;
        // Remove from processes array
        processes.splice(serverProcessIndex, 1);
      }
    }

    // Rebuild the CLI
    const buildChild = Bun.spawn(['bun', 'run', 'build'], {
      cwd: cliDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    /** @type {string} */
    let buildOutput = '';

    // Read stdout
    (async () => {
      if (buildChild.stdout) {
        const reader = buildChild.stdout.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value);
            buildOutput += text;
            process.stdout.write(`[REBUILD] ${text}`);
          }
        } catch (error) {
          // Stream ended
        }
      }
    })();

    // Read stderr
    (async () => {
      if (buildChild.stderr) {
        const reader = buildChild.stderr.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value);
            buildOutput += text;
            process.stderr.write(`[REBUILD] ${text}`);
          }
        } catch (error) {
          // Stream ended
        }
      }
    })();

    const exitCode = await buildChild.exited;
    const buildSuccess = exitCode === 0;

    if (buildSuccess && !isShuttingDown) {
      log('REBUILD', '✅ Build completed, restarting server...');
      // Restart the server
      const serverProcess = await startActualCliServer();

      if (serverProcess) {
        // Wait for server to be ready after rebuild (CRITICAL FIX)
        const port = process.env.SERVER_PORT || 3000;
        const url = `http://localhost:${port}/api/server/ping`;
        const ready = await waitForServer(url);

        if (ready && !isShuttingDown) {
          log('REBUILD', '✅ Server restarted successfully!');
        } else if (!isShuttingDown) {
          log('REBUILD', '❌ Server failed health check after rebuild');
          cleanup('rebuild-health-check-failed');
        }
      } else if (!isShuttingDown) {
        log('REBUILD', '❌ Failed to spawn server process after rebuild');
        cleanup('rebuild-spawn-failed');
      }
    } else if (!buildSuccess) {
      log('REBUILD', '❌ Build failed, server stopped');
    }
    // If buildSuccess && isShuttingDown, we silently skip server restart
  } catch (error) {
    log('REBUILD', `Error during rebuild: ${error.message}`);
  } finally {
    isRebuilding = false;

    // If another rebuild was queued while we were rebuilding, start it now
    // But only if we're not shutting down
    if (rebuildQueued && !isShuttingDown) {
      log('REBUILD', '🔄 Starting queued rebuild...');
      rebuildAndRestartServer();
    }
  }
}

/**
 * Start file watchers for all watched directories
 * @returns {void}
 */
function startFileWatcher() {
  log('WATCH', '👀 Watching for changes in backend packages...');
  log(
    'WATCH',
    'Monitored packages: cli, core, server, api-client, plugin-bootstrap, plugin-sql, config'
  );

  watchDirs.forEach((dir, index) => {
    // Check if directory exists before watching (CRITICAL FIX)
    if (!existsSync(dir)) {
      const packageName = getPackageNameFromDir(dir);
      log('WATCH', `⚠️  Skipping ${packageName} - directory does not exist: ${dir}`);
      return;
    }

    const packageName = getPackageNameFromDir(dir); // Extract package name from path

    try {
      const watcher = watch(dir, { recursive: true }, (eventType, filename) => {
        if (isShuttingDown) return;

        // Only watch TypeScript files
        if (filename && (filename.endsWith('.ts') || filename.endsWith('.tsx'))) {
          // Debounce to avoid multiple rapid rebuilds
          if (rebuildDebounceTimer) {
            clearTimeout(rebuildDebounceTimer);
          }

          rebuildDebounceTimer = setTimeout(() => {
            if (!isShuttingDown) {
              log('WATCH', `📝 File changed in ${packageName}: ${filename}`);
              rebuildAndRestartServer();
            }
          }, 300); // 300ms debounce
        }
      });

      watcher.on('error', (error) => {
        log('WATCH', `Watcher error for ${packageName}: ${error.message}`);
      });

      // Store each watcher in processes for cleanup
      processes.push({ name: `FILE-WATCHER-${index}`, child: watcher, type: 'watcher' });
    } catch (error) {
      log('WATCH', `Failed to watch ${packageName}: ${error.message}`);
    }
  });
}

/**
 * Cleanup all processes and exit
 * @param {string} [signal='SIGTERM'] - The signal that triggered cleanup
 * @returns {void}
 */
function cleanup(signal = 'SIGTERM') {
  if (isShuttingDown) return; // Prevent multiple cleanup calls
  isShuttingDown = true;

  // Clear any pending rebuild timers
  if (rebuildDebounceTimer) {
    clearTimeout(rebuildDebounceTimer);
    rebuildDebounceTimer = null;
  }

  log('DEV', `Received ${signal}, shutting down...`);

  if (processes.length === 0) {
    log('DEV', 'No processes to clean up, exiting...');
    process.exit(0);
    return;
  }

  // Kill all processes immediately and more aggressively
  const killPromises = processes.map(({ name, child, type }) => {
    return new Promise((resolve) => {
      // Handle file watcher specially
      if (type === 'watcher') {
        try {
          if (child && typeof child.close === 'function') {
            child.close();
            log('DEV', `${name} stopped`);
          }
        } catch (error) {
          // Ignore errors during watcher cleanup
        }
        resolve(true);
        return;
      }

      if (child && 'kill' in child) {
        log('DEV', `Terminating ${name}...`);

        // Different timeout based on process type
        const timeout = type === 'server' ? 1000 : 500;

        // Set up a timeout for force kill
        const forceKillTimeout = setTimeout(() => {
          if (child && 'exitCode' in child && child.exitCode === null) {
            log('DEV', `Force killing ${name}...`);
            try {
              child.kill('SIGKILL');
            } catch (error) {
              // Ignore errors during force kill
            }
          }
          resolve(true);
        }, timeout);

        // Listen for the process to exit
        child.exited
          .then(() => {
            clearTimeout(forceKillTimeout);
            log('DEV', `${name} stopped`);
            resolve(true);
          })
          .catch(() => {
            clearTimeout(forceKillTimeout);
            resolve(true);
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
          resolve(true);
        }
      } else {
        resolve(true);
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

/**
 * Main entry point
 * @returns {Promise<void>}
 */
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
