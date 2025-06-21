import { logger } from '@elizaos/core';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { TestCommandOptions, TestResult } from '../types';
import { DirectoryInfo } from '@/src/utils/directory-detection';
import { startTestServer } from '../utils/server-utils';
import { loadProjectConfig } from '@/src/utils/config-loader';
import { getAvailablePort } from '../utils/port-utils';

/**
 * Check if Cypress is available in the project
 */
export function hasCypressTests(projectPath: string): boolean {
  const cypressDir = path.join(projectPath, 'cypress');
  const cypressConfig = path.join(projectPath, 'cypress.config.ts');
  const cypressConfigJs = path.join(projectPath, 'cypress.config.js');

  return existsSync(cypressDir) && (existsSync(cypressConfig) || existsSync(cypressConfigJs));
}

/**
 * Run Cypress tests for a project
 */
export async function runCypressTests(
  testPath: string | undefined,
  options: TestCommandOptions,
  _projectInfo: DirectoryInfo
): Promise<TestResult> {
  // Determine the project path
  const projectPath = testPath ? path.resolve(process.cwd(), testPath) : process.cwd();

  // Check if Cypress tests exist
  if (!hasCypressTests(projectPath)) {
    logger.warn('Skipped frontend tests with Cypress because no Cypress configuration found');
    return { failed: false };
  }

  logger.info('Found Cypress tests, preparing to run...');

  // Clean up any existing screenshots before running tests
  await cleanupScreenshots(projectPath);

  // Start the test server
  const port = options.port || (await getAvailablePort(3000));
  logger.info(`Starting test server on port ${port}...`);

  let serverProcess: any = null;

  try {
    // Try to load the project config, but don't fail if it doesn't work
    let config: any = {};
    try {
      config = await loadProjectConfig(projectPath);
    } catch (error) {
      logger.warn('Could not load project config, continuing with default configuration');
    }

    // Start the server with the loaded configuration
    serverProcess = await startTestServer({
      port,
      projectPath,
      character: config.character,
      plugins: config.plugins || [],
    });

    // Wait for server to be ready
    await waitForServer(port);
    logger.info('Test server is ready');

    // Run Cypress tests
    const cypressResult = await runCypressCommand(projectPath, port);

    // Check for screenshot errors
    const screenshotErrors = await checkForScreenshotErrors(projectPath);
    if (screenshotErrors.length > 0) {
      logger.error(`Found ${screenshotErrors.length} error screenshots:`);
      screenshotErrors.forEach((screenshot) => {
        logger.error(`  - ${screenshot}`);
      });
    }

    return {
      failed: !cypressResult.success || screenshotErrors.length > 0,
    };
  } catch (error) {
    logger.error('Error running Cypress tests:', error);
    return { failed: true };
  } finally {
    // Clean up server process
    if (serverProcess) {
      logger.info('Stopping test server...');
      try {
        // For detached processes, kill the process group
        if (process.platform !== 'win32' && serverProcess.pid) {
          try {
            process.kill(-serverProcess.pid, 'SIGTERM');
          } catch (e) {
            // Fallback to regular kill
            serverProcess.kill('SIGTERM');
          }
        } else {
          serverProcess.kill('SIGTERM');
        }

        // Give it time to shut down gracefully
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Force kill if still running
        try {
          if (process.platform !== 'win32' && serverProcess.pid) {
            process.kill(-serverProcess.pid, 'SIGKILL');
          } else if (!serverProcess.killed) {
            serverProcess.kill('SIGKILL');
          }
        } catch (e) {
          // Process already dead
        }
      } catch (error) {
        logger.error('Error stopping server:', error);
      }
    }
  }
}

/**
 * Wait for the server to be ready
 */
async function waitForServer(port: number, maxAttempts: number = 30): Promise<void> {
  const checkInterval = 1000; // 1 second

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`http://localhost:${port}/`);
      if (response.ok || response.status === 404) {
        // Server is responding
        return;
      }
    } catch (error) {
      // Server not ready yet
    }

    if (i < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }
  }

  throw new Error(`Server did not start within ${maxAttempts} seconds`);
}

/**
 * Run the Cypress command
 */
async function runCypressCommand(
  projectPath: string,
  port: number
): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const cypressEnv = {
      ...process.env,
      CYPRESS_baseUrl: `http://localhost:${port}`,
      NODE_ENV: 'test',
      CI: 'true', // Run in CI mode to avoid interactive prompts
    };

    // Determine the package manager
    const hasYarnLock = existsSync(path.join(projectPath, 'yarn.lock'));
    const hasPnpmLock = existsSync(path.join(projectPath, 'pnpm-lock.yaml'));
    const hasBunLock = existsSync(path.join(projectPath, 'bun.lockb'));

    let packageManager = 'npm';
    let runCommand = 'npx';

    if (hasBunLock) {
      packageManager = 'bun';
      runCommand = 'bunx';
    } else if (hasYarnLock) {
      packageManager = 'yarn';
      runCommand = 'yarn';
    } else if (hasPnpmLock) {
      packageManager = 'pnpm';
      runCommand = 'pnpm exec';
    }

    // Run Cypress directly using npx/bunx/yarn/pnpm exec
    const cypressArgs =
      runCommand === 'yarn'
        ? ['cypress', 'run', '--headless']
        : runCommand === 'pnpm exec'
          ? ['cypress', 'run', '--headless']
          : runCommand.includes('x')
            ? ['cypress', 'run', '--headless']
            : ['cypress', 'run', '--headless'];

    // For npx/bunx, we use the command directly
    const command = runCommand.includes('x') ? runCommand : packageManager;
    const args = runCommand.includes('x')
      ? cypressArgs
      : [runCommand.replace('pnpm ', ''), ...cypressArgs];

    logger.info(`Running: ${command} ${args.join(' ')}`);

    const cypressProcess = spawn(command, args, {
      cwd: projectPath,
      env: cypressEnv,
      stdio: 'pipe',
    });

    let output = '';

    cypressProcess.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      // Log Cypress output line by line
      text
        .split('\n')
        .filter((line: string) => line.trim())
        .forEach((line: string) => {
          logger.debug(`[Cypress] ${line}`);
        });
    });

    cypressProcess.stderr.on('data', (data) => {
      const text = data.toString();
      output += text;
      // Log errors
      text
        .split('\n')
        .filter((line: string) => line.trim())
        .forEach((line: string) => {
          logger.error(`[Cypress Error] ${line}`);
        });
    });

    cypressProcess.on('close', (code) => {
      const success = code === 0;
      if (success) {
        logger.success('Cypress tests completed successfully');
      } else {
        logger.error(`Cypress tests failed with exit code ${code}`);
      }
      resolve({ success, output });
    });

    cypressProcess.on('error', (error) => {
      logger.error('Failed to start Cypress:', error);
      resolve({ success: false, output: error.toString() });
    });
  });
}

/**
 * Clean up existing screenshots before running tests
 */
async function cleanupScreenshots(projectPath: string): Promise<void> {
  const screenshotsDir = path.join(projectPath, 'cypress', 'screenshots');

  if (!existsSync(screenshotsDir)) {
    return;
  }

  try {
    const { rm } = await import('fs/promises');
    await rm(screenshotsDir, { recursive: true, force: true });
    logger.debug('Cleaned up existing screenshots');
  } catch (error) {
    logger.warn('Could not clean up screenshots:', error);
  }
}

/**
 * Check for error screenshots in the Cypress screenshots folder
 */
async function checkForScreenshotErrors(projectPath: string): Promise<string[]> {
  const screenshotsDir = path.join(projectPath, 'cypress', 'screenshots');

  if (!existsSync(screenshotsDir)) {
    return [];
  }

  const { readdir } = await import('fs/promises');

  try {
    const files = await readdir(screenshotsDir, { recursive: true });

    // Filter for image files (screenshots)
    const screenshots = files.filter(
      (file) =>
        typeof file === 'string' &&
        (file.endsWith('.png') || file.endsWith('.jpg') || file.endsWith('.jpeg'))
    );

    if (screenshots.length > 0) {
      logger.warn(`Found ${screenshots.length} screenshots (may indicate test failures)`);
    }

    return screenshots as string[];
  } catch (error) {
    logger.error('Error checking for screenshots:', error);
    return [];
  }
}
