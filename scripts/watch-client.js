#!/usr/bin/env bun

import chokidar from 'chokidar';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

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

let isBuilding = false;
let buildQueue = false;

function log(message) {
  console.log(`[CLIENT-WATCHER] ${new Date().toLocaleTimeString()} - ${message}`);
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    log(`Running: ${command} ${args.join(' ')} in ${cwd}`);
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
    log('Build already in progress, queuing next build...');
    buildQueue = true;
    return;
  }

  isBuilding = true;
  log('Building client...');

  try {
    // Build the client
    await runCommand('bun', ['run', 'build'], clientDir);
    log('Client build completed');

    // Copy client dist to CLI
    const cliDir = path.resolve(__dirname, '../packages/cli');
    await runCommand('bun', ['run', 'src/scripts/copy-client-dist.ts'], cliDir);
    log('Client dist copied to CLI package');

  } catch (error) {
    console.error('[CLIENT-WATCHER] Build failed:', error);
  } finally {
    isBuilding = false;
    
    // If there was a queued build, run it now
    if (buildQueue) {
      buildQueue = false;
      setTimeout(buildClient, 100); // Small delay to avoid rapid rebuilds
    }
  }
}

// Initial build
log('Starting client watcher...');
log('Running initial client build...');
buildClient();

// Watch for changes
const watcher = chokidar.watch([clientSrcDir, clientPublicDir, ...clientConfigFiles], {
  ignoreInitial: true,
  ignored: [
    '**/node_modules/**', 
    '**/dist/**', 
    '**/.turbo/**',
    '**/info.json',
    '**/*.log',
    '**/.git/**'
  ],
  persistent: true,
});

watcher.on('change', (filePath) => {
  log(`File changed: ${path.relative(clientDir, filePath)}`);
  buildClient();
});

watcher.on('add', (filePath) => {
  log(`File added: ${path.relative(clientDir, filePath)}`);
  buildClient();
});

watcher.on('unlink', (filePath) => {
  log(`File removed: ${path.relative(clientDir, filePath)}`);
  buildClient();
});

watcher.on('error', (error) => {
  console.error('[CLIENT-WATCHER] Watcher error:', error);
});

log('Client watcher started. Monitoring for file changes...');

// Handle process termination
process.on('SIGINT', () => {
  log('Shutting down client watcher...');
  watcher.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('Shutting down client watcher...');
  watcher.close();
  process.exit(0);
}); 