#!/usr/bin/env node

import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import fs from 'fs';

// Configuration from environment
const SERVER_PORT = process.env.TEST_SERVER_PORT || 3000;
const MAX_RETRIES = parseInt(process.env.TEST_MAX_RETRIES) || 60;
const RETRY_DELAY = parseInt(process.env.TEST_RETRY_DELAY) || 1000;
const CYPRESS_HEADED = process.env.CYPRESS_HEADED !== 'false';
const CI = process.env.CI === 'true';
const VERBOSE = process.env.VERBOSE === 'true' || !CI;

// Colors for console output (disabled in CI)
const colors = CI ? {
  reset: '',
  green: '',
  red: '',
  yellow: '',
  blue: '',
  cyan: '',
  magenta: ''
} : {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

function log(message, color = 'reset', prefix = '') {
  const timestamp = new Date().toISOString();
  const formattedMessage = CI 
    ? `[${timestamp}] ${prefix}${message}`
    : `${colors[color]}${prefix}${message}${colors.reset}`;
  console.log(formattedMessage);
}

function logVerbose(message, color = 'reset') {
  if (VERBOSE) {
    log(message, color);
  }
}

// Ensure required directories exist
function ensureDirectories() {
  const dirs = ['cypress/screenshots', 'cypress/videos', 'cypress/downloads'];
  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logVerbose(`📁 Created directory: ${dir}`, 'cyan');
    }
  });
}

// Check if server is ready with better error handling
function waitForServer(port, retries = MAX_RETRIES) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    
    const check = () => {
      attempts++;
      
      const options = {
        hostname: 'localhost',
        port: port,
        path: '/api/goals',
        method: 'GET',
        timeout: 5000
      };
      
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            log(`✅ Server is ready on port ${port}`, 'green');
            logVerbose(`   Response: ${res.statusCode} ${data}`, 'cyan');
            resolve();
          } else {
            logVerbose(`   Server returned ${res.statusCode}`, 'yellow');
            retry();
          }
        });
      });
      
      req.on('error', (err) => {
        logVerbose(`   Connection error: ${err.message}`, 'yellow');
        retry();
      });
      
      req.on('timeout', () => {
        req.destroy();
        logVerbose('   Request timeout', 'yellow');
        retry();
      });
      
      req.end();
    };
    
    const retry = () => {
      if (attempts >= retries) {
        reject(new Error(`Server failed to start after ${retries} attempts`));
      } else {
        const message = `⏳ Waiting for server... (attempt ${attempts}/${retries})`;
        if (CI || attempts % 5 === 0) {
          log(message, 'yellow');
        } else {
          logVerbose(message, 'yellow');
        }
        setTimeout(check, RETRY_DELAY);
      }
    };
    
    check();
  });
}

// Kill process tree (important for CI)
function killProcessTree(pid) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', pid, '/T', '/F'], { shell: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch (e) {
    // Process might already be dead
    logVerbose(`Could not kill process ${pid}: ${e.message}`, 'yellow');
  }
}

// Main test runner
async function runTests() {
  let serverProcess = null;
  let exitCode = 0;
  const startTime = Date.now();
  
  try {
    ensureDirectories();
    
    // Start the dev server with proper process group
    log('🚀 Starting Eliza server...', 'blue');
    const serverEnv = { ...process.env, PORT: SERVER_PORT };
    
    serverProcess = spawn('npm', ['run', 'dev'], {
      stdio: 'pipe',
      shell: true,
      cwd: process.cwd(),
      env: serverEnv,
      detached: process.platform !== 'win32' // Create process group on Unix
    });
    
    // Capture server output
    let serverOutput = '';
    serverProcess.stdout.on('data', (data) => {
      const text = data.toString();
      serverOutput += text;
      if (VERBOSE) {
        process.stdout.write(`${colors.magenta}[Server]${colors.reset} ${text}`);
      }
    });
    
    serverProcess.stderr.on('data', (data) => {
      const text = data.toString();
      serverOutput += text;
      if (VERBOSE || text.toLowerCase().includes('error')) {
        process.stderr.write(`${colors.red}[Server Error]${colors.reset} ${text}`);
      }
    });
    
    // Handle server crash
    serverProcess.on('error', (err) => {
      throw new Error(`Failed to start server: ${err.message}`);
    });
    
    serverProcess.on('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        logVerbose(`Server exited with code ${code}`, 'red');
      }
    });
    
    // Wait for server to be ready
    await waitForServer(SERVER_PORT);
    
    // Run Cypress tests
    log('\n🧪 Running Cypress tests...', 'blue');
    const cypressArgs = CYPRESS_HEADED ? ['run', 'cypress:run'] : ['run', 'cypress:run', '--', '--headless'];
    
    const cypressEnv = {
      ...process.env,
      CYPRESS_baseUrl: `http://localhost:${SERVER_PORT}`,
      FORCE_COLOR: '1'
    };
    
    const cypressProcess = spawn('npm', cypressArgs, {
      stdio: 'inherit',
      shell: true,
      cwd: process.cwd(),
      env: cypressEnv
    });
    
    // Wait for Cypress to complete
    await new Promise((resolve, reject) => {
      cypressProcess.on('close', (code) => {
        if (code === 0) {
          log('\n✅ All tests passed!', 'green');
          resolve();
        } else {
          exitCode = code || 1;
          reject(new Error(`Cypress exited with code ${code}`));
        }
      });
      
      cypressProcess.on('error', (err) => {
        reject(new Error(`Cypress failed to start: ${err.message}`));
      });
    });
    
  } catch (error) {
    log(`\n❌ Test failed: ${error.message}`, 'red');
    exitCode = 1;
    
    // In CI, save server output for debugging
    if (CI && serverOutput) {
      const logFile = 'cypress/server-output.log';
      fs.writeFileSync(logFile, serverOutput);
      log(`📝 Server output saved to ${logFile}`, 'yellow');
    }
  } finally {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`\n⏱️  Total duration: ${duration}s`, 'cyan');
    
    // Clean up server process
    if (serverProcess && !serverProcess.killed) {
      log('\n🛑 Shutting down server...', 'yellow');
      
      try {
        // Kill the process group
        if (process.platform !== 'win32') {
          process.kill(-serverProcess.pid, 'SIGTERM');
        } else {
          serverProcess.kill('SIGTERM');
        }
        
        // Force kill after 5 seconds
        setTimeout(() => {
          if (!serverProcess.killed) {
            killProcessTree(serverProcess.pid);
          }
        }, 5000);
        
        // Wait a bit for cleanup
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (e) {
        logVerbose(`Error during cleanup: ${e.message}`, 'yellow');
      }
    }
    
    process.exit(exitCode);
  }
}

// Handle process termination gracefully
let isCleaningUp = false;

function cleanup(signal) {
  if (isCleaningUp) return;
  isCleaningUp = true;
  
  log(`\n\n⚠️  Received ${signal}, cleaning up...`, 'yellow');
  process.exit(1);
}

process.on('SIGINT', () => cleanup('SIGINT'));
process.on('SIGTERM', () => cleanup('SIGTERM'));
process.on('SIGHUP', () => cleanup('SIGHUP'));

// Uncaught errors
process.on('uncaughtException', (err) => {
  log(`\n💥 Uncaught exception: ${err.message}`, 'red');
  console.error(err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  log(`\n💥 Unhandled rejection: ${reason}`, 'red');
  console.error(promise);
  process.exit(1);
});

// Run the tests
log('🎯 Goals Plugin E2E Test Suite', 'blue');
log('================================', 'blue');
log(`📋 Configuration:`, 'cyan');
log(`   Server Port: ${SERVER_PORT}`, 'cyan');
log(`   Max Retries: ${MAX_RETRIES}`, 'cyan');
log(`   Retry Delay: ${RETRY_DELAY}ms`, 'cyan');
log(`   Headed Mode: ${CYPRESS_HEADED}`, 'cyan');
log(`   CI Mode: ${CI}`, 'cyan');
log(`   Verbose: ${VERBOSE}\n`, 'cyan');

runTests(); 