import { execSync } from 'child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import { TEST_TIMEOUTS } from '../test-timeouts';

export interface TestContext {
  testTmpDir: string;
  elizaosCmd: string;
  originalCwd: string;
}

/**
 * Standard setup for CLI tests - creates temp directory and sets up CLI command
 */
export async function setupTestEnvironment(): Promise<TestContext> {
  const originalCwd = process.cwd();
  const testTmpDir = await mkdtemp(join(tmpdir(), 'eliza-test-'));
  process.chdir(testTmpDir);

  const scriptDir = join(__dirname, '../..');
  const scriptPath = join(scriptDir, 'dist/index.js');
  const elizaosCmd = `bun run "${scriptPath}"`;

  return { testTmpDir, elizaosCmd, originalCwd };
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
export async function createTestProject(elizaosCmd: string, projectName: string): Promise<void> {
  const timeout = TEST_TIMEOUTS.PROJECT_CREATION;

  // Platform-specific options
  const platformOptions: any = {
    stdio: 'pipe',
  };
  
  if (process.platform === 'win32') {
    platformOptions.timeout = timeout * 1.5;
    platformOptions.killSignal = 'SIGKILL' as NodeJS.Signals;
    platformOptions.windowsHide = true;
  } else if (process.platform === 'darwin') {
    // macOS specific options for project creation
    platformOptions.timeout = timeout * 1.25;
    platformOptions.killSignal = 'SIGTERM' as NodeJS.Signals;
    platformOptions.env = {
      ...process.env,
      PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH}`,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8'
    };
  } else {
    platformOptions.timeout = timeout;
  }

  try {
    execSync(`${elizaosCmd} create ${projectName} --yes`, platformOptions);
    process.chdir(projectName);
  } catch (error: any) {
    console.error(`[Create Test Project Error] Failed to create ${projectName}:`, {
      status: error.status,
      signal: error.signal,
      platform: process.platform,
      stdout: error.stdout?.toString() || '',
      stderr: error.stderr?.toString() || ''
    });
    throw error;
  }
}

/**
 * Helper to run CLI command and expect it to succeed
 */
export function runCliCommand(
  elizaosCmd: string,
  args: string,
  options: { timeout?: number } = {}
): string {
  const timeout = options.timeout || TEST_TIMEOUTS.STANDARD_COMMAND;

  // Platform-specific options
  const platformOptions: any = {};
  
  if (process.platform === 'win32') {
    platformOptions.timeout = timeout * 1.5; // 50% longer timeout for Windows
    platformOptions.killSignal = 'SIGKILL' as NodeJS.Signals;
    platformOptions.windowsHide = true;
  } else if (process.platform === 'darwin') {
    // macOS specific options
    platformOptions.timeout = timeout * 1.25; // 25% longer timeout for macOS
    platformOptions.killSignal = 'SIGTERM' as NodeJS.Signals;
    // Add environment variables for better macOS compatibility
    platformOptions.env = {
      ...process.env,
      PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH}`,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8'
    };
  } else {
    platformOptions.timeout = timeout;
  }

  try {
    return execSync(`${elizaosCmd} ${args}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], // Explicit stdio handling
      ...platformOptions,
    });
  } catch (error: any) {
    // Enhanced error reporting for debugging
    const errorDetails = {
      command: `${elizaosCmd} ${args}`,
      platform: process.platform,
      timeout: platformOptions.timeout,
      status: error.status,
      signal: error.signal,
      stdout: error.stdout?.toString() || '',
      stderr: error.stderr?.toString() || '',
      pid: error.pid
    };
    console.error('[CLI Command Error]', errorDetails);
    throw error;
  }
}

/**
 * Helper to run CLI command silently (suppressing console output)
 */
export function runCliCommandSilently(
  elizaosCmd: string,
  args: string,
  options: { timeout?: number } = {}
): string {
  const timeout = options.timeout || TEST_TIMEOUTS.STANDARD_COMMAND;

  // Platform-specific options
  const platformOptions: any = {};
  
  if (process.platform === 'win32') {
    platformOptions.timeout = timeout * 1.5;
    platformOptions.killSignal = 'SIGKILL' as NodeJS.Signals;
    platformOptions.windowsHide = true;
  } else if (process.platform === 'darwin') {
    // macOS specific options
    platformOptions.timeout = timeout * 1.25; // 25% longer timeout for macOS
    platformOptions.killSignal = 'SIGTERM' as NodeJS.Signals;
    platformOptions.env = {
      ...process.env,
      PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH}`,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8'
    };
  } else {
    platformOptions.timeout = timeout;
  }

  try {
    return execSync(`${elizaosCmd} ${args}`, {
      encoding: 'utf8',
      stdio: 'pipe',
      ...platformOptions,
    });
  } catch (error: any) {
    // Enhanced error reporting for debugging silent commands
    console.error(`[Silent CLI Command Error] ${elizaosCmd} ${args}:`, {
      status: error.status,
      signal: error.signal,
      platform: process.platform,
      timeout: platformOptions.timeout
    });
    throw error;
  }
}

/**
 * Helper to run CLI command and expect it to fail
 */
export function expectCliCommandToFail(
  elizaosCmd: string,
  args: string,
  options: { timeout?: number } = {}
): { status: number; output: string } {
  const timeout = options.timeout || TEST_TIMEOUTS.STANDARD_COMMAND;

  // Platform-specific options
  const platformOptions: any = {};
  
  if (process.platform === 'win32') {
    platformOptions.timeout = timeout * 1.5;
    platformOptions.killSignal = 'SIGKILL' as NodeJS.Signals;
    platformOptions.windowsHide = true;
  } else if (process.platform === 'darwin') {
    // macOS specific options
    platformOptions.timeout = timeout * 1.25;
    platformOptions.killSignal = 'SIGTERM' as NodeJS.Signals;
    platformOptions.env = {
      ...process.env,
      PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH}`,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8'
    };
  } else {
    platformOptions.timeout = timeout;
  }

  try {
    const result = execSync(`${elizaosCmd} ${args}`, {
      encoding: 'utf8',
      stdio: 'pipe',
      ...platformOptions,
    });
    throw new Error(`Command should have failed but succeeded with output: ${result}`);
  } catch (e: any) {
    return {
      status: e.status || -1,
      output: (e.stdout || '') + (e.stderr || ''),
    };
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
  const pollInterval = isMacOS && isCI ? 3000 : (isMacOS ? 2000 : 1000);
  const requestTimeout = isMacOS && isCI ? 6000 : (isMacOS ? 4000 : 2000);
  
  console.log(`[DEBUG] Waiting for server on port ${port}, max wait: ${maxWaitTime}ms, poll interval: ${pollInterval}ms`);
  console.log(`[DEBUG] Environment: CI=${isCI}, macOS=${isMacOS}`);

  // First, check if anything is listening on the port using a simple connection test
  let connectionAttempts = 0;
  const maxConnectionAttempts = 3;

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
        console.log(`[DEBUG] Connection attempt ${connectionAttempts}/${maxConnectionAttempts} failed - no process listening on port ${port}, ${Math.round(timeRemaining/1000)}s remaining`);
        
        if (connectionAttempts >= maxConnectionAttempts) {
          // Check if process is still running but not bound yet
          const timeRemaining = maxWaitTime - (Date.now() - startTime);
          if (timeRemaining < maxWaitTime * 0.3) { // Less than 30% time remaining
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
          'Accept': 'application/json',
          'Connection': 'keep-alive',
          'Cache-Control': 'no-cache'
        }
      });

      clearTimeout(timeoutId);
      if (response.ok) {
        console.log(`[DEBUG] Server responded with status ${response.status}`);
        // Server is ready, give it more time to stabilize especially on macOS CI
        const stabilizationTime = isMacOS && isCI ? 3000 : (isMacOS ? 2000 : 1000);
        console.log(`[DEBUG] Stabilizing for ${stabilizationTime}ms...`);
        await new Promise((resolve) => setTimeout(resolve, stabilizationTime));
        return;
      } else {
        console.log(`[DEBUG] Server responded with status ${response.status}, continuing to wait...`);
      }
    } catch (error) {
      // Server not ready yet, continue polling
      const timeRemaining = maxWaitTime - (Date.now() - startTime);
      const errorMsg = error instanceof Error ? error.message : 'unknown error';
      console.log(`[DEBUG] Server not ready yet (${errorMsg}), ${Math.round(timeRemaining/1000)}s remaining`);
      
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
      const netstatResult = execSync(`netstat -ano | findstr :${port}`, {
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
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
        } catch (e) {
          // Ignore if process is already dead
        }
      }
    } else if (process.platform === 'darwin') {
      // macOS: More reliable process killing with better error handling
      try {
        // First try to find processes listening on the port with increased timeout
        const lsofResult = execSync(`lsof -ti:${port}`, {
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 10000 // Increased timeout for CI
        });
        
        const pids = lsofResult.trim().split('\n').filter(pid => pid && /^\d+$/.test(pid));
        console.log(`[DEBUG] Found ${pids.length} processes on port ${port}: ${pids.join(', ')}`);
        
        for (const pid of pids) {
          try {
            // Check if process exists first
            execSync(`ps -p ${pid}`, { stdio: 'ignore', timeout: 2000 });
            
            // Try SIGTERM first
            console.log(`[DEBUG] Sending SIGTERM to PID ${pid}`);
            execSync(`kill -TERM ${pid}`, { stdio: 'ignore', timeout: 3000 });
            
            // Wait longer for graceful shutdown on macOS CI
            const waitTime = process.env.CI === 'true' ? 3000 : 1000;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            
            // Check if still running, then force kill
            try {
              execSync(`kill -0 ${pid}`, { stdio: 'ignore', timeout: 2000 });
              console.log(`[DEBUG] Process ${pid} still running, sending SIGKILL`);
              execSync(`kill -9 ${pid}`, { stdio: 'ignore', timeout: 3000 });
              await new Promise(resolve => setTimeout(resolve, 500));
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
      execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { 
        stdio: 'ignore',
        timeout: 5000
      });
    }
    
    // Give processes time to actually terminate
    await new Promise(resolve => setTimeout(resolve, process.platform === 'darwin' ? 2000 : 1000));
  } catch (e) {
    // Ignore port cleanup errors but log them for debugging
    console.log(`[DEBUG] Port cleanup for ${port} encountered error:`, e instanceof Error ? e.message : 'unknown');
  }
}

/**
 * Get the correct bun executable path for the platform
 */
export function getBunExecutable(): string {
  // On Windows, we might need to add .exe extension
  const bunCmd = process.platform === 'win32' ? 'bun.exe' : 'bun';
  console.log(`[DEBUG] Using bun executable: ${bunCmd}`);
  return bunCmd;
}

/**
 * Cross-platform file operations utility
 */
export const crossPlatform = {
  removeDir: (path: string) => {
    try {
      if (process.platform === 'win32') {
        execSync(`if exist "${path}" rmdir /s /q "${path}"`, { stdio: 'ignore' });
      } else {
        execSync(`rm -rf "${path}"`, { stdio: 'ignore' });
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  },

  removeFile: (path: string) => {
    try {
      if (process.platform === 'win32') {
        execSync(`if exist "${path}" del /q "${path}"`, { stdio: 'ignore' });
      } else {
        execSync(`rm -f "${path}"`, { stdio: 'ignore' });
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  },

  killProcessOnPort: killProcessOnPort,
};

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
    const { spawn } = require('child_process');

    // Force stdio to 'ignore' to prevent hanging streams on Windows
    const processOptions = {
      ...options,
      stdio: ['ignore', 'ignore', 'ignore'], // Ignore all stdio to prevent hanging
    };

    const childProcess = spawn(command, args, processOptions);

    // Track the process for cleanup
    this.processes.add(childProcess);

    // Remove from tracking when process exits naturally
    childProcess.on('exit', () => {
      this.processes.delete(childProcess);
    });

    return childProcess;
  }

  /**
   * Gracefully terminate a single process with platform-specific handling
   */
  async terminateProcess(process: any): Promise<void> {
    if (!process || process.exitCode !== null || process.killed) {
      return;
    }

    try {
      // Create exit promise
      const exitPromise = new Promise<void>((resolve) => {
        if (process.exitCode !== null) {
          resolve();
          return;
        }

        const cleanup = () => {
          process.removeAllListeners();
          resolve();
        };

        process.once('exit', cleanup);
        process.once('error', cleanup);
      });

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
