#!/usr/bin/env bun

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let processes = [];

function log(prefix, message) {
  console.log(`[${prefix}] ${new Date().toLocaleTimeString()} - ${message}`);
}

function startProcess(name, command, args, cwd) {
  log('DEV', `Starting ${name}...`);
  
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    shell: true,
  });

  child.on('close', (code) => {
    log('DEV', `${name} exited with code ${code}`);
    if (code !== 0) {
      log('DEV', `${name} failed, shutting down all processes...`);
      cleanup();
    }
  });

  child.on('error', (error) => {
    log('DEV', `${name} error: ${error.message}`);
    cleanup();
  });

  processes.push({ name, child });
  return child;
}

function cleanup() {
  log('DEV', 'Shutting down all processes...');
  
  processes.forEach(({ name, child }) => {
    if (!child.killed) {
      log('DEV', `Terminating ${name}...`);
      child.kill('SIGTERM');
      
      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (!child.killed) {
          log('DEV', `Force killing ${name}...`);
          child.kill('SIGKILL');
        }
      }, 5000);
    }
  });

  setTimeout(() => {
    process.exit(0);
  }, 1000);
}

// Handle process termination
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);

// Start both processes
const rootDir = path.resolve(__dirname, '..');

log('DEV', 'Starting development environment...');

// Start client watcher
startProcess(
  'CLIENT-WATCHER', 
  'bun', 
  ['run', 'scripts/watch-client.js'], 
  rootDir
);

// Start CLI server
startProcess(
  'CLI-SERVER', 
  'turbo', 
  ['run', 'start', '--filter=./packages/cli', '--no-cache', '--force'], 
  rootDir
);

log('DEV', 'Development environment started. Press Ctrl+C to stop.'); 