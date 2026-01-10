#!/usr/bin/env node

import { spawn } from 'child_process';
import http from 'http';

const SERVER_PORT = 3000;
const MAX_RETRIES = 60;
const RETRY_DELAY = 1000;

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// Check if server is ready
function waitForServer(port, retries = MAX_RETRIES) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    
    const check = () => {
      attempts++;
      
      const req = http.get(`http://localhost:${port}/`, (res) => {
        if (res.statusCode === 200 || res.statusCode === 404) {
          log(`✅ Server is ready on port ${port} (Status: ${res.statusCode})`, 'green');
          resolve();
        } else {
          log(`⏳ Waiting for server... (Status: ${res.statusCode})`, 'yellow');
          retry();
        }
      });
      
      req.on('error', (err) => {
        log(`⏳ Waiting for server... (Connection error: ${err.message})`, 'yellow');
        retry();
      });
      
      req.end();
    };
    
    const retry = () => {
      if (attempts >= retries) {
        reject(new Error(`Server failed to start after ${retries} attempts`));
      } else {
        setTimeout(check, RETRY_DELAY);
      }
    };
    
    check();
  });
}

// Main test runner
async function runTests() {
  let serverProcess = null;
  let exitCode = 0;
  
  try {
    // Start the dev server
    log('🚀 Starting Eliza server...', 'blue');
    serverProcess = spawn('npm', ['run', 'dev'], {
      stdio: 'pipe',
      shell: true,
      cwd: process.cwd(),
      detached: true
    });
    
    // Capture server output
    serverProcess.stdout.on('data', (data) => {
      process.stdout.write(`[Server] ${data}`);
    });
    
    serverProcess.stderr.on('data', (data) => {
      process.stderr.write(`[Server Error] ${data}`);
    });
    
    // Wait for server to be ready
    await waitForServer(SERVER_PORT);
    
    // Run Cypress tests
    log('\n🧪 Running Cypress tests...', 'blue');
    const cypressProcess = spawn('npm', ['run', 'cypress:run'], {
      stdio: 'inherit',
      shell: true,
      cwd: process.cwd()
    });
    
    // Wait for Cypress to complete
    await new Promise((resolve, reject) => {
      cypressProcess.on('close', (code) => {
        if (code === 0) {
          log('\n✅ All tests passed!', 'green');
          resolve();
        } else {
          exitCode = code;
          reject(new Error(`Cypress exited with code ${code}`));
        }
      });
      
      cypressProcess.on('error', (err) => {
        reject(err);
      });
    });
    
  } catch (error) {
    log(`\n❌ Test failed: ${error.message}`, 'red');
    exitCode = 1;
  } finally {
    // Clean up server process
    if (serverProcess) {
      log('\n🛑 Shutting down server...', 'yellow');
      
      // Kill the entire process group using the detached PID
      try {
        process.kill(-serverProcess.pid);
      } catch (e) {
        log(`Could not kill server process group: ${e.message}. Fallback to single process kill.`, 'yellow');
        serverProcess.kill();
      }
    }
    
    process.exit(exitCode);
  }
}

// Handle process termination
process.on('SIGINT', () => {
  log('\n\n⚠️  Interrupted by user', 'yellow');
  process.exit(1);
});

process.on('SIGTERM', () => {
  log('\n\n⚠️  Terminated', 'yellow');
  process.exit(1);
});

// Run the tests
log('🎯 Todo Plugin E2E Test Suite', 'blue');
log('================================\n', 'blue');
runTests(); 