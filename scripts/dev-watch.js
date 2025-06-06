#!/usr/bin/env bun

import chokidar from 'chokidar';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const clientDir = path.resolve(__dirname, '../packages/client');
const clientSrcDir = path.join(clientDir, 'src');
const clientPublicDir = path.join(clientDir, 'public');
const clientConfigFiles = [
  path.join(clientDir, 'vite.config.ts'),
  path.join(clientDir, 'tailwind.config.ts'),
  path.join(clientDir, 'index.html'),
  path.join(clientDir, 'postcss.config.js'),
];

let processes = [];
let isBuilding = false;
let buildQueue = false;
let wss = null;

function log(prefix, message) {
  console.log(`[${prefix}] ${new Date().toLocaleTimeString()} - ${message}`);
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    log('BUILD', `Running: ${command} ${args.join(' ')} in ${cwd}`);
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: true,
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

async function buildClient() {
  if (isBuilding) {
    log('BUILD', 'Build already in progress, queuing next build...');
    buildQueue = true;
    return;
  }

  isBuilding = true;
  log('BUILD', 'Building client...');

  try {
    // Build the client
    await runCommand('bun', ['run', 'build'], clientDir);
    log('BUILD', 'Client build completed');

    // Copy client dist to CLI
    const cliDir = path.resolve(__dirname, '../packages/cli');
    await runCommand('bun', ['run', 'src/scripts/copy-client-dist.ts'], cliDir);
    log('BUILD', 'Client dist copied to CLI package');

    // Notify browsers to refresh
    notifyBrowserRefresh();

  } catch (error) {
    console.error('[BUILD] Build failed:', error);
  } finally {
    isBuilding = false;
    
    // If there was a queued build, run it now
    if (buildQueue) {
      buildQueue = false;
      setTimeout(buildClient, 100);
    }
  }
}

function notifyBrowserRefresh() {
  if (wss) {
    log('REFRESH', 'Notifying browsers to refresh...');
    wss.clients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(JSON.stringify({ type: 'refresh' }));
      }
    });
  }
}

function startWebSocketServer() {
  wss = new WebSocketServer({ port: 3001 });
  
  wss.on('connection', (ws) => {
    log('WS', 'Browser connected for auto-refresh');
    
    ws.on('close', () => {
      log('WS', 'Browser disconnected');
    });
  });

  log('WS', 'Auto-refresh WebSocket server started on port 3001');
}

function startCliServer() {
  log('CLI', 'Starting CLI server...');
  
  const rootDir = path.resolve(__dirname, '..');
  
  const child = spawn('turbo', ['run', 'start', '--filter=./packages/cli', '--no-cache', '--force'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true,
  });

  child.on('close', (code) => {
    log('CLI', `CLI server exited with code ${code}`);
    if (code !== 0) {
      log('CLI', 'CLI server failed, shutting down...');
      cleanup();
    }
  });

  child.on('error', (error) => {
    log('CLI', `CLI server error: ${error.message}`);
    cleanup();
  });

  processes.push({ name: 'CLI-SERVER', child });
  return child;
}

function cleanup() {
  log('DEV', 'Shutting down all processes...');
  
  // Close WebSocket server immediately
  if (wss) {
    try {
      wss.close();
      log('DEV', 'WebSocket server closed');
    } catch (error) {
      // Ignore errors during WebSocket cleanup
    }
  }

  // Kill processes more aggressively
  processes.forEach(({ name, child }) => {
    if (child && !child.killed) {
      log('DEV', `Terminating ${name}...`);
      try {
        // Try SIGTERM first
        child.kill('SIGTERM');
        
        // Force kill after 2 seconds instead of 5
        setTimeout(() => {
          if (child && !child.killed) {
            log('DEV', `Force killing ${name}...`);
            child.kill('SIGKILL');
          }
        }, 2000);
      } catch (error) {
        // Process might already be dead, ignore errors
      }
    }
  });

  // Exit faster
  setTimeout(() => {
    log('DEV', 'Cleanup complete');
    process.exit(0);
  }, 3000);
}

// Handle process termination
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);

async function main() {
  try {
    log('DEV', 'Starting development environment with auto-refresh...');
    
    // Start WebSocket server for browser refresh
    startWebSocketServer();
    
    // Initial build
    log('BUILD', 'Running initial client build...');
    await buildClient();
    
    // Start CLI server
    startCliServer();
    
    // Start watching for changes
    log('WATCH', 'Starting file watcher...');
    const watcher = chokidar.watch([clientSrcDir, clientPublicDir, ...clientConfigFiles], {
      ignoreInitial: true,
      ignored: [
        '**/node_modules/**', 
        '**/dist/**', 
        '**/.turbo/**',
        '**/info.json',
        '**/src/lib/info.json',
        '**/*.log',
        '**/.git/**',
        '**/.vite/**',
        '**/coverage/**'
      ],
      persistent: true,
    });

    function shouldIgnoreFile(filePath) {
      const relativePath = path.relative(clientDir, filePath);
      return relativePath.includes('info.json') || 
             relativePath.includes('node_modules') ||
             relativePath.includes('dist') ||
             relativePath.includes('.turbo') ||
             relativePath.endsWith('.log');
    }

    watcher.on('change', (filePath) => {
      if (shouldIgnoreFile(filePath)) {
        return;
      }
      log('WATCH', `File changed: ${path.relative(clientDir, filePath)}`);
      buildClient();
    });

    watcher.on('add', (filePath) => {
      if (shouldIgnoreFile(filePath)) {
        return;
      }
      log('WATCH', `File added: ${path.relative(clientDir, filePath)}`);
      buildClient();
    });

    watcher.on('unlink', (filePath) => {
      if (shouldIgnoreFile(filePath)) {
        return;
      }
      log('WATCH', `File removed: ${path.relative(clientDir, filePath)}`);
      buildClient();
    });

    watcher.on('error', (error) => {
      console.error('[WATCH] Watcher error:', error);
    });

    log('DEV', '🚀 Development environment ready!');
    log('DEV', '📱 Frontend: http://localhost:3000');
    log('DEV', '🔄 Auto-refresh enabled - changes will reload the page automatically!');
    log('DEV', 'Press Ctrl+C to stop all services.');
    
  } catch (error) {
    log('DEV', `Failed to start development environment: ${error.message}`);
    cleanup();
  }
}

main(); 