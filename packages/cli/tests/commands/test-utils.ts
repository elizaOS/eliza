import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import { TEST_TIMEOUTS } from '../test-timeouts';
import { bunExec, bunExecSimple } from '../../src/utils/bun-exec';
import { parseCommand } from '../utils/bun-test-helpers';

/**
 * Helper function to execute shell commands using Bun.spawn
 * This is used for system commands that don't go through bunExec
 */
async function execShellCommand(
  command: string,
  options: { encoding?: string; stdio?: string; timeout?: number } = {}
): Promise<string> {
  // For complex shell commands, we need to use shell
  const shell = process.platform === 'win32' ? ['cmd', '/c'] : ['sh', '-c'];
  const proc = Bun.spawn([...shell, command], {
    stdout: options.stdio === 'ignore' ? 'ignore' : 'pipe',
    stderr: options.stdio === 'ignore' ? 'ignore' : 'pipe',
  });

  let timeoutId: Timer | null = null;
  if (options.timeout) {
    timeoutId = setTimeout(() => {
      proc.kill();
    }, options.timeout);
  }

  try {
    if (options.stdio === 'ignore') {
      await proc.exited;
      return '';
    }

    const [stdout, stderr] = await Promise.all([
      proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(''),
      proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(''),
    ]);

    await proc.exited;

    if (proc.exitCode !== 0 && !options.stdio) {
      const error = new Error(`Command failed: ${command}\nstderr: ${stderr}`) as Error & {
        status: number | null;
        stdout: string;
        stderr: string;
      };
      error.status = proc.exitCode;
      error.stdout = stdout;
      error.stderr = stderr;
      throw error;
    }

    return stdout;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export interface TestContext {
  testTmpDir: string;
  originalCwd: string;
}

/**
 * Standard setup for CLI tests - creates temp directory
 */
export async function setupTestEnvironment(): Promise<TestContext> {
  const originalCwd = process.cwd();
  const testTmpDir = await mkdtemp(join(tmpdir(), 'eliza-test-'));
  process.chdir(testTmpDir);

  return { testTmpDir, originalCwd };
}

/**
 * Standard cleanup for CLI tests - restores directory and removes temp files
 */
export async function cleanupTestEnvironment(context: TestContext): Promise<void> {
  safeChangeDirectory(context.originalCwd);

  if (context.testTmpDir && context.testTmpDir.includes('eliza-test-')) {
    try {
      await rm(context.testTmpDir, { recursive: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Safe directory change helper that handles missing directories
 */
export function safeChangeDirectory(targetDir: string): void {
  if (existsSync(targetDir)) {
    try {
      process.chdir(targetDir);
    } catch (e) {
      try {
        process.chdir(tmpdir());
      } catch (e2) {
        // Ignore if we can't change to temp dir
      }
    }
  } else {
    try {
      process.chdir(tmpdir());
    } catch (e) {
      // Ignore if we can't change to temp dir
    }
  }
}

/**
 * Helper to create a basic ElizaOS project for testing
 */
export async function createTestProject(projectName: string): Promise<void> {
  const platformOptions = getPlatformOptions({
    stdio: 'pipe',
    timeout: TEST_TIMEOUTS.PROJECT_CREATION,
  });

  try {
    const result = await bunExecSimple(`elizaos create ${projectName} --yes`);
    process.chdir(projectName);
  } catch (error: any) {
    console.error(`[Create Test Project Error] Failed to create ${projectName}:`, {
      platform: process.platform,
      stdout: error.stdout?.toString() || '',
      stderr: error.stderr?.toString() || '',
    });
    throw error;
  }
}

/**
 * Helper to validate that help output contains expected strings
 */
export function expectHelpOutput(
  output: string,
  command: string,
  expectedOptions: string[] = []
): void {
  if (!output.includes(`Usage: elizaos ${command}`)) {
    throw new Error(`Expected help output to contain 'Usage: elizaos ${command}', got: ${output}`);
  }

  for (const option of expectedOptions) {
    if (!output.includes(option)) {
      throw new Error(`Expected help output to contain '${option}', got: ${output}`);
    }
  }
}

/**
 * Helper to create a test plugin directory structure
 */
export async function createTestPluginStructure(pluginName: string): Promise<void> {
  const pluginDir = `plugin-${pluginName}`;
  await mkdir(pluginDir, { recursive: true });
  await mkdir(join(pluginDir, 'src'), { recursive: true });

  // Create basic package.json
  const packageJson = {
    name: `@elizaos/plugin-${pluginName}`,
    version: '1.0.0',
    type: 'module',
    main: 'dist/index.js',
    elizaPlugin: true,
  };

  await writeFile(join(pluginDir, 'package.json'), JSON.stringify(packageJson, null, 2));
  await writeFile(join(pluginDir, 'src/index.ts'), 'export default {};');

  process.chdir(pluginDir);
}

/**
 * Helper to create a basic agent JSON file
 */
export async function createTestAgent(agentName: string): Promise<void> {
  const agentData = {
    name: agentName,
    system: 'You are a helpful assistant.',
    bio: ['I am a test agent'],
    messageExamples: [
      [{ user: 'user', content: { text: 'Hello' } }],
      [{ user: 'assistant', content: { text: 'Hi there!' } }],
    ],
    style: {
      all: ['helpful', 'friendly'],
    },
  };

  await writeFile(`${agentName}.json`, JSON.stringify(agentData, null, 2));
}

/**
 * Common assertions for CLI tests
 */
export const assertions = {
  /**
   * Assert that output matches one of several possible patterns
   */
  matchesAny(output: string, patterns: RegExp[]): void {
    const matches = patterns.some((pattern) => pattern.test(output));
    if (!matches) {
      throw new Error(`Output did not match any expected patterns. Output: ${output}`);
    }
  },

  /**
   * Assert that command output indicates success
   */
  isSuccessOutput(output: string): void {
    const successPatterns = [/successfully/i, /complete/i, /created/i, /installed/i, /updated/i];

    this.matchesAny(output, successPatterns);
  },

  /**
   * Assert that file exists
   */
  fileExists(filePath: string): void {
    if (!existsSync(filePath)) {
      throw new Error(`Expected file to exist: ${filePath}`);
    }
  },
};

/**
 * Wait for server to be ready by polling health endpoint
 * @param port - Port number to check
 * @param maxWaitTime - Maximum time to wait in milliseconds
 * @param endpoint - Endpoint to check (default: '/api/agents')
 */
export async function waitForServerReady(
  port: number,
  maxWaitTime: number = TEST_TIMEOUTS.SERVER_STARTUP,
  endpoint: string = '/api/agents'
): Promise<void> {
  const startTime = Date.now();
  const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
  const isMacOS = process.platform === 'darwin';

  // More conservative timeouts for macOS CI
  const pollInterval = isMacOS && isCI ? 3000 : isMacOS ? 2000 : 1000;
  const requestTimeout = isMacOS && isCI ? 6000 : isMacOS ? 4000 : 2000;

  console.log(
    `[DEBUG] Waiting for server on port ${port}, max wait: ${maxWaitTime}ms, poll interval: ${pollInterval}ms`
  );
  console.log(`[DEBUG] Environment: CI=${isCI}, macOS=${isMacOS}`);

  // First, check if anything is listening on the port using a simple connection test
  let connectionAttempts = 0;
  // Base max attempts on actual polling intervals rather than arbitrary time division
  const maxConnectionAttempts = Math.max(5, Math.floor(maxWaitTime / (pollInterval * 2)));

  while (Date.now() - startTime < maxWaitTime) {
    try {
      // Try a basic connection test first for better error diagnosis
      const net = require('net');
      const canConnect = await new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        const connectTimeout = setTimeout(() => {
          socket.destroy();
          resolve(false);
        }, requestTimeout / 2);

        socket.connect(port, '127.0.0.1', () => {
          clearTimeout(connectTimeout);
          socket.destroy();
          resolve(true);
        });

        socket.on('error', () => {
          clearTimeout(connectTimeout);
          socket.destroy();
          resolve(false);
        });
      });

      if (!canConnect) {
        connectionAttempts++;
        const timeRemaining = maxWaitTime - (Date.now() - startTime);
        console.log(
          `[DEBUG] Connection attempt ${connectionAttempts}/${maxConnectionAttempts} failed - no process listening on port ${port}, ${Math.round(timeRemaining / 1000)}s remaining`
        );

        if (connectionAttempts >= maxConnectionAttempts) {
          // Check if process is still running but not bound yet
          const timeRemaining = maxWaitTime - (Date.now() - startTime);
          if (timeRemaining < maxWaitTime * 0.3) {
            // Less than 30% time remaining
            console.log(`[DEBUG] Giving up on connection test, trying HTTP anyway...`);
          } else {
            await new Promise((resolve) => setTimeout(resolve, pollInterval));
            continue;
          }
        } else {
          await new Promise((resolve) => setTimeout(resolve, pollInterval / 2));
          continue;
        }
      }

      // Now try HTTP request
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), requestTimeout);

      const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'ElizaOS-Test-Client/1.0',
          Accept: 'application/json',
          Connection: 'keep-alive',
          'Cache-Control': 'no-cache',
        },
      });

      clearTimeout(timeoutId);
      if (response.ok) {
        console.log(`[DEBUG] Server responded with status ${response.status}`);
        // Server is ready, give it more time to stabilize especially on macOS CI
        const stabilizationTime = isMacOS && isCI ? 3000 : isMacOS ? 2000 : 1000;
        console.log(`[DEBUG] Stabilizing for ${stabilizationTime}ms...`);
        await new Promise((resolve) => setTimeout(resolve, stabilizationTime));
        return;
      } else {
        console.log(
          `[DEBUG] Server responded with status ${response.status}, continuing to wait...`
        );
      }
    } catch (error) {
      // Server not ready yet, continue polling
      const timeRemaining = maxWaitTime - (Date.now() - startTime);
      const errorMsg = error instanceof Error ? error.message : 'unknown error';
      console.log(
        `[DEBUG] Server not ready yet (${errorMsg}), ${Math.round(timeRemaining / 1000)}s remaining`
      );

      // Reset connection attempts on network errors
      if (errorMsg.includes('fetch') || errorMsg.includes('AbortError')) {
        connectionAttempts = 0;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Server failed to become ready on port ${port} within ${maxWaitTime}ms`);
}

/**
 * Kill process on a specific port with cross-platform support
 */
export async function killProcessOnPort(port: number): Promise<void> {
  try {
    if (process.platform === 'win32') {
      // Windows: More reliable process killing
      const netstatResult = await execShellCommand(`netstat -ano | findstr :${port}`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      const lines = netstatResult.split('\n').filter((line) => line.includes(`:${port}`));
      const pids = lines
        .map((line) => {
          const parts = line.trim().split(/\s+/);
          return parts[parts.length - 1];
        })
        .filter((pid) => pid && pid !== '0');

      for (const pid of pids) {
        try {
          await execShellCommand(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
        } catch (e) {
          // Ignore if process is already dead
        }
      }
    } else if (process.platform === 'darwin') {
      // macOS: More reliable process killing with better error handling
      try {
        // First try to find processes listening on the port with increased timeout
        const lsofResult = await execShellCommand(`lsof -ti:${port}`, {
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 10000, // Increased timeout for CI
        });

        const pids = lsofResult
          .trim()
          .split('\n')
          .filter((pid) => pid && /^\d+$/.test(pid));
        console.log(`[DEBUG] Found ${pids.length} processes on port ${port}: ${pids.join(', ')}`);

        for (const pid of pids) {
          try {
            // Check if process exists first
            await execShellCommand(`ps -p ${pid}`, { stdio: 'ignore', timeout: 2000 });

            // Try SIGTERM first
            console.log(`[DEBUG] Sending SIGTERM to PID ${pid}`);
            await execShellCommand(`kill -TERM ${pid}`, { stdio: 'ignore', timeout: 3000 });

            // Wait longer for graceful shutdown on macOS CI
            const waitTime = process.env.CI === 'true' ? 3000 : 1000;
            await new Promise((resolve) => setTimeout(resolve, waitTime));

            // Check if still running, then force kill
            try {
              await execShellCommand(`kill -0 ${pid}`, { stdio: 'ignore', timeout: 2000 });
              console.log(`[DEBUG] Process ${pid} still running, sending SIGKILL`);
              await execShellCommand(`kill -9 ${pid}`, { stdio: 'ignore', timeout: 3000 });
              await new Promise((resolve) => setTimeout(resolve, 500));
            } catch (e) {
              // Process already dead, good
              console.log(`[DEBUG] Process ${pid} terminated gracefully`);
            }
          } catch (e) {
            // Process doesn't exist or already killed, ignore
            console.log(`[DEBUG] Process ${pid} not found or already terminated`);
          }
        }
      } catch (e) {
        // No processes found on port, which is fine
        console.log(`[DEBUG] No processes found on port ${port} (expected if port is free)`);
      }
    } else {
      // Other Unix systems
      await execShellCommand(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, {
        stdio: 'ignore',
        timeout: 5000,
      });
    }

    // Give processes time to actually terminate
    await new Promise((resolve) =>
      setTimeout(resolve, process.platform === 'darwin' ? 2000 : 1000)
    );
  } catch (e) {
    // Ignore port cleanup errors but log them for debugging
    console.log(
      `[DEBUG] Port cleanup for ${port} encountered error:`,
      e instanceof Error ? e.message : 'unknown'
    );
  }
}

/**
 * Cross-platform file operations utility
 */
export const crossPlatform = {
  removeDir: async (path: string) => {
    try {
      if (process.platform === 'win32') {
        await execShellCommand(`if exist "${path}" rmdir /s /q "${path}"`, { stdio: 'ignore' });
      } else {
        await execShellCommand(`rm -rf "${path}"`, { stdio: 'ignore' });
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  },

  removeFile: async (path: string) => {
    try {
      if (process.platform === 'win32') {
        await execShellCommand(`if exist "${path}" del /q "${path}"`, { stdio: 'ignore' });
      } else {
        await execShellCommand(`rm -f "${path}"`, { stdio: 'ignore' });
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  },

  killProcessOnPort: killProcessOnPort,
};

/**
 * Get platform-specific options for execSync calls
 */
export function getPlatformOptions(baseOptions: any = {}): any {
  const platformOptions = { ...baseOptions };

  // Always ensure environment variables are passed
  platformOptions.env = {
    ...process.env,
    ...baseOptions.env, // Preserve any custom env vars from baseOptions
  };

  if (process.platform === 'win32') {
    // Only scale the timeout if one was explicitly provided
    if (platformOptions.timeout !== undefined) {
      platformOptions.timeout = platformOptions.timeout * 1.5;
    }
    platformOptions.killSignal = 'SIGKILL' as NodeJS.Signals;
    platformOptions.windowsHide = true;
  } else if (process.platform === 'darwin') {
    // macOS specific options
    // Only scale the timeout if one was explicitly provided
    if (platformOptions.timeout !== undefined) {
      platformOptions.timeout = platformOptions.timeout * 1.25;
    }
    platformOptions.killSignal = 'SIGTERM' as NodeJS.Signals;
    // Add macOS specific locale
    platformOptions.env = {
      ...platformOptions.env,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    };
  }

  return platformOptions;
}

/**
 * Cross-platform test process manager
 * Handles proper process lifecycle management for CLI tests
 */
export class TestProcessManager {
  private processes: Set<any> = new Set();

  /**
   * Spawn a process with proper error handling and cleanup
   */
  spawn(command: string, args: string[], options: any = {}): any {
    // Force stdio to 'ignore' to prevent hanging streams on Windows, unless allowOutput is true
    const processOptions = {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdout: options.allowOutput ? 'inherit' : 'ignore',
      stderr: options.allowOutput ? 'inherit' : 'ignore',
      stdin: 'ignore',
    };

    const childProcess = Bun.spawn([command, ...args], processOptions);

    // Track the process for cleanup
    this.processes.add(childProcess);

    // Remove from tracking when process exits naturally
    childProcess.exited.then(() => {
      this.processes.delete(childProcess);
    });

    return childProcess;
  }

  /**
   * Gracefully terminate a single process with platform-specific handling
   */
  async terminateProcess(process: any): Promise<void> {
    if (!process || process.exitCode !== null) {
      return;
    }

    try {
      // For Bun processes, we have an exited promise
      const exitPromise = process.exited;

      if (process.platform === 'win32') {
        // Windows: Try graceful termination first
        process.kill('SIGTERM');

        // Wait briefly for graceful shutdown
        const gracefulTimeout = new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(false), 1000);
        });

        const wasGraceful = await Promise.race([exitPromise.then(() => true), gracefulTimeout]);

        // Force kill if still running
        if (!wasGraceful && process.exitCode === null) {
          try {
            process.kill('SIGKILL');
          } catch (e) {
            // Process might already be dead
          }
        }
      } else {
        // Unix: SIGTERM should be sufficient
        process.kill('SIGTERM');
      }

      // Wait for process to exit with timeout
      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(resolve, TEST_TIMEOUTS.PROCESS_CLEANUP);
      });

      await Promise.race([exitPromise, timeoutPromise]);
    } catch (error) {
      // Ignore termination errors
    } finally {
      this.processes.delete(process);
    }
  }

  /**
   * Clean up all tracked processes
   */
  async cleanup(): Promise<void> {
    const cleanupPromises = Array.from(this.processes).map((proc) => this.terminateProcess(proc));

    await Promise.allSettled(cleanupPromises);
    this.processes.clear();
  }

  /**
   * Get count of active processes
   */
  getActiveCount(): number {
    return this.processes.size;
  }
}
