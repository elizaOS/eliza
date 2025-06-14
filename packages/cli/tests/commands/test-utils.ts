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
  
  const windowsOptions = process.platform === 'win32' ? {
    timeout: timeout * 1.5,
    killSignal: 'SIGKILL',
    windowsHide: true,
  } : {};

  execSync(`${elizaosCmd} create ${projectName} --yes`, {
    stdio: 'pipe',
    timeout,
    ...windowsOptions,
  });
  process.chdir(projectName);
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
  
  // On Windows, use different timeout and signal handling
  const windowsOptions = process.platform === 'win32' ? {
    timeout: timeout * 1.5, // 50% longer timeout for Windows
    killSignal: 'SIGKILL',   // Use SIGKILL instead of SIGTERM
    windowsHide: true,       // Hide console window
  } : {};

  return execSync(`${elizaosCmd} ${args}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], // Explicit stdio handling
    timeout,
    ...windowsOptions,
  });
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
  
  const windowsOptions = process.platform === 'win32' ? {
    timeout: timeout * 1.5,
    killSignal: 'SIGKILL',
    windowsHide: true,
  } : {};

  return execSync(`${elizaosCmd} ${args}`, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout,
    ...windowsOptions,
  });
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
  
  const windowsOptions = process.platform === 'win32' ? {
    timeout: timeout * 1.5,
    killSignal: 'SIGKILL',
    windowsHide: true,
  } : {};

  try {
    const result = execSync(`${elizaosCmd} ${args}`, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout,
      ...windowsOptions,
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
  const pollInterval = 1000; // Check every 1 second
  
  while (Date.now() - startTime < maxWaitTime) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      
      const response = await fetch(`http://localhost:${port}${endpoint}`, {
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      if (response.ok) {
        // Server is ready, give it one more second to stabilize
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return;
      }
    } catch (error) {
      // Server not ready yet, continue polling
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
      const netstatResult = execSync(
        `netstat -ano | findstr :${port}`,
        { encoding: 'utf8', stdio: 'pipe' }
      );
      
      const lines = netstatResult.split('\n').filter(line => line.includes(`:${port}`));
      const pids = lines.map(line => {
        const parts = line.trim().split(/\s+/);
        return parts[parts.length - 1];
      }).filter(pid => pid && pid !== '0');
      
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
        } catch (e) {
          // Ignore if process is already dead
        }
      }
    } else {
      // Unix systems
      execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
    }
  } catch (e) {
    // Ignore port cleanup errors
  }
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
        
        const wasGraceful = await Promise.race([
          exitPromise.then(() => true),
          gracefulTimeout
        ]);
        
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
    const cleanupPromises = Array.from(this.processes).map(proc => 
      this.terminateProcess(proc)
    );
    
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
