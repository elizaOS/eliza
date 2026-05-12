import { afterAll, beforeAll, beforeEach } from 'bun:test';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Store the original NGROK_DOMAIN to restore later
const originalNgrokDomain = process.env.NGROK_DOMAIN;
const originalNgrokAuthToken = process.env.NGROK_AUTH_TOKEN;

// Global test state
const activeNgrokProcesses: Set<number> = new Set();

// Kill all ngrok processes before tests start
async function killAllNgrokProcesses(): Promise<void> {
  return new Promise((resolve) => {
    // Use more specific pattern to only kill actual ngrok processes
    const killProcess = spawn('pkill', ['-x', 'ngrok']);
    killProcess.on('exit', () => {
      // Give it a moment to fully terminate
      setTimeout(resolve, 1000);
    });
    killProcess.on('error', () => {
      // pkill might not exist on all systems, that's OK
      resolve();
    });
  });
}

// Check if any ngrok processes are running
async function checkNgrokProcesses(): Promise<boolean> {
  return new Promise((resolve) => {
    // Use more specific pattern to only find actual ngrok processes
    const checkProcess = spawn('pgrep', ['-x', 'ngrok']);
    let hasProcesses = false;

    checkProcess.stdout.on('data', (data) => {
      const pids = data.toString().trim().split('\n').filter(Boolean);
      if (pids.length > 0) {
        hasProcesses = true;
        pids.forEach((pid: string) => {
          const pidNum = parseInt(pid, 10);
          if (!Number.isNaN(pidNum)) {
            activeNgrokProcesses.add(pidNum);
          }
        });
      }
    });

    checkProcess.on('exit', () => {
      resolve(hasProcesses);
    });

    checkProcess.on('error', () => {
      resolve(false);
    });
  });
}

// Check if this is a pay-as-you-go account by trying to start without domain
async function checkIfPayAsYouGo(): Promise<boolean> {
  if (!originalNgrokAuthToken) {
    return false;
  }

  return new Promise((resolve) => {
    const envWithoutDomain: NodeJS.ProcessEnv = { ...process.env };
    delete envWithoutDomain.NGROK_DOMAIN;

    const checkProcess = spawn('ngrok', ['http', '8080'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: envWithoutDomain,
    });

    let isPayAsYouGo = false;

    checkProcess.stderr?.on('data', (data: Buffer) => {
      const message = data.toString();
      if (message.includes('ERR_NGROK_15002') || message.includes('Pay-as-you-go')) {
        isPayAsYouGo = true;
        checkProcess.kill();
      }
    });

    checkProcess.on('exit', () => {
      resolve(isPayAsYouGo);
    });

    // Give it a few seconds then kill it
    setTimeout(() => {
      if (!checkProcess.killed) {
        checkProcess.kill();
      }
    }, 3000);
  });
}

beforeAll(async () => {
  // Only run setup for test files, not for the main process
  const isTestFile = process.argv.some((arg) => arg.includes('.test.') || arg.includes('.spec.'));
  if (!isTestFile) {
    return;
  }

  console.log('\n🧹 Cleaning up any existing ngrok processes...');
  await killAllNgrokProcesses();

  // Check if this is a pay-as-you-go account
  const isPayAsYouGo = await checkIfPayAsYouGo();

  if (isPayAsYouGo && originalNgrokDomain) {
    // For pay-as-you-go accounts, we MUST use the domain
    console.log('📌 Pay-as-you-go account detected, using domain:', originalNgrokDomain);
    process.env.NGROK_DOMAIN = originalNgrokDomain;
  } else {
    // For free accounts, we should NOT use a fixed domain to avoid conflicts
    console.log('🆓 Free account detected, using random URLs for tests');
    delete process.env.NGROK_DOMAIN;
  }

  console.log('✅ Test environment ready\n');
});

beforeEach(async () => {
  // Only run for test files
  const isTestFile = process.argv.some((arg) => arg.includes('.test.') || arg.includes('.spec.'));
  if (!isTestFile) {
    return;
  }

  // Check for lingering ngrok processes between tests
  const hasProcesses = await checkNgrokProcesses();
  if (hasProcesses) {
    console.log('⚠️  Found lingering ngrok processes, cleaning up...');
    await killAllNgrokProcesses();
  }

  // Clear the active processes set
  activeNgrokProcesses.clear();
});

afterAll(async () => {
  // Only run for test files
  const isTestFile = process.argv.some((arg) => arg.includes('.test.') || arg.includes('.spec.'));
  if (!isTestFile) {
    return;
  }

  console.log('\n🧹 Final cleanup...');

  // Kill any remaining ngrok processes
  await killAllNgrokProcesses();

  // Restore original environment
  if (originalNgrokDomain) {
    process.env.NGROK_DOMAIN = originalNgrokDomain;
  }

  console.log('✅ Cleanup complete\n');
});

// Export helper to track ngrok processes
export function trackNgrokProcess(pid: number): void {
  activeNgrokProcesses.add(pid);
}

export function untrackNgrokProcess(pid: number): void {
  activeNgrokProcesses.delete(pid);
}

// Export the original domain for tests that need it
export const ORIGINAL_NGROK_DOMAIN = originalNgrokDomain;
