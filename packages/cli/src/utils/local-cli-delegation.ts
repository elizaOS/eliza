import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '@elizaos/core';

/**
 * Local CLI delegation utility for enforcing local CLI usage across all commands
 *
 * This utility checks for a local @elizaos/cli installation and delegates to it
 * if available, ensuring consistent behavior across all CLI commands.
 */

/**
 * Checks if we're currently running from a local CLI installation
 * @returns true if running from local CLI, false otherwise
 */
function isRunningFromLocalCli(): boolean {
  try {
    const currentScriptPath = process.argv[1];
    if (!currentScriptPath) return false;

    // Get the expected local CLI path
    const expectedLocalCliPath = path.join(
      process.cwd(),
      'node_modules',
      '@elizaos',
      'cli',
      'dist',
      'index.js'
    );

    // Compare exact paths to prevent infinite delegation
    const isInLocalCli = path.resolve(currentScriptPath) === path.resolve(expectedLocalCliPath);

    return isInLocalCli;
  } catch (error) {
    logger.debug('Error checking if running from local CLI:', error);
    return false;
  }
}

/**
 * Gets the path to the local CLI installation if it exists
 * @returns the path to local CLI index.js or null if not found
 */
function getLocalCliPath(): string | null {
  const localCliPath = path.join(
    process.cwd(),
    'node_modules',
    '@elizaos',
    'cli',
    'dist',
    'index.js'
  );

  return existsSync(localCliPath) ? localCliPath : null;
}

/**
 * Sets up the environment for local CLI execution
 * Similar to server-manager.ts environment setup
 */
function setupLocalEnvironment(): Record<string, string> {
  const env = { ...process.env };

  // Add local node_modules to NODE_PATH for proper module resolution
  const localModulesPath = path.join(process.cwd(), 'node_modules');
  if (existsSync(localModulesPath)) {
    if (env.NODE_PATH) {
      env.NODE_PATH = `${localModulesPath}${path.delimiter}${env.NODE_PATH}`;
    } else {
      env.NODE_PATH = localModulesPath;
    }
  }

  // Add local .bin to PATH to prioritize local executables
  const localBinPath = path.join(process.cwd(), 'node_modules', '.bin');
  if (existsSync(localBinPath)) {
    if (env.PATH) {
      env.PATH = `${localBinPath}${path.delimiter}${env.PATH}`;
    } else {
      env.PATH = localBinPath;
    }
  }

  // Ensure color output is preserved
  env.FORCE_COLOR = '1';

  return env;
}

/**
 * Delegates execution to the local CLI installation
 * @param localCliPath - Path to the local CLI index.js
 * @returns Promise that resolves when the local CLI process exits
 */
async function delegateToLocalCli(localCliPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    logger.info('Using local @elizaos/cli installation');

    const nodeExecutable = process.execPath;
    const args = process.argv.slice(2); // Get all arguments after 'node script.js'
    const env = setupLocalEnvironment();

    // Spawn the local CLI process
    const childProcess = spawn(nodeExecutable, [localCliPath, ...args], {
      stdio: 'inherit', // Inherit stdio to maintain interactive behavior
      env,
      cwd: process.cwd(),
    });

    // Handle process completion
    childProcess.on('exit', (code, signal) => {
      if (code !== null) {
        // Exit with the same code as the child process
        process.exit(code);
      } else if (signal) {
        // If killed by signal, exit with appropriate code
        const exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
        process.exit(exitCode);
      }
      resolve();
    });

    // Handle process errors
    childProcess.on('error', (error) => {
      logger.error(`Failed to start local CLI: ${error.message}`);
      reject(error);
    });

    // Handle process signals to forward them to the child
    const forwardSignal = (signal: NodeJS.Signals) => {
      process.on(signal, () => {
        if (childProcess.killed === false) {
          childProcess.kill(signal);
        }
      });
    };

    forwardSignal('SIGINT');
    forwardSignal('SIGTERM');
  });
}

/**
 * Detects if we're running in a test or CI environment where delegation should be skipped
 * @returns true if in test or CI environment, false otherwise
 */
function isTestOrCiEnvironment(): boolean {
  // Check for common test and CI environment indicators
  const testAndCiIndicators = [
    process.env.NODE_ENV === 'test',
    process.env.ELIZA_TEST_MODE === 'true',
    process.env.ELIZA_TEST_MODE === '1',
    process.env.ELIZA_CLI_TEST_MODE === 'true',
    process.env.ELIZA_SKIP_LOCAL_CLI_DELEGATION === 'true',
    process.env.ELIZA_DISABLE_LOCAL_CLI_DELEGATION === 'true',
    process.env.BUN_TEST === 'true',
    process.env.VITEST === 'true',
    process.env.JEST_WORKER_ID !== undefined,
    process.argv.includes('--test'),
    process.argv.includes('test'),
    // Check if we're running under a test runner
    process.argv[1]?.includes('test') === true,
    // Check if parent process is a test runner
    process.env.npm_lifecycle_event === 'test',
    // CI environment detection
    process.env.CI === 'true',
    process.env.CONTINUOUS_INTEGRATION === 'true',
    process.env.GITHUB_ACTIONS === 'true',
    process.env.GITLAB_CI === 'true',
    process.env.JENKINS_URL !== undefined,
    process.env.TRAVIS === 'true',
    process.env.CIRCLECI === 'true',
    process.env.BUILDKITE === 'true',
    process.env.DRONE === 'true',
    process.env.TEAMCITY_VERSION !== undefined,
    process.env.APPVEYOR === 'true',
    process.env.CODEBUILD_BUILD_ID !== undefined,
  ];

  return testAndCiIndicators.some((indicator) => indicator === true);
}

/**
 * Attempts to delegate to local CLI if available and not already running from it
 * This function should be called at the very beginning of the main CLI entry point
 *
 * @returns Promise<boolean> - true if delegated to local CLI, false if continuing with current CLI
 */
export async function tryDelegateToLocalCli(): Promise<boolean> {
  try {
    // Skip delegation in test or CI environments
    if (isTestOrCiEnvironment()) {
      logger.debug('Running in test or CI environment, skipping local CLI delegation');
      return false;
    }

    // Skip delegation for update command (should always use global CLI)
    const args = process.argv.slice(2);
    if (args.length > 0 && args[0] === 'update') {
      logger.debug('Update command detected, skipping local CLI delegation');
      return false;
    }

    // Skip delegation if we're already running from local CLI
    if (isRunningFromLocalCli()) {
      logger.debug('Already running from local CLI, continuing execution');
      return false;
    }

    // Check if local CLI exists
    const localCliPath = getLocalCliPath();
    if (!localCliPath) {
      logger.debug('No local CLI found, using global installation');
      return false;
    }

    // Final fail-safe: prevent delegation loops
    if (process.env._ELIZA_CLI_DELEGATION_DEPTH) {
      const depth = parseInt(process.env._ELIZA_CLI_DELEGATION_DEPTH, 10);
      if (depth > 0) {
        logger.debug('Delegation depth exceeded, preventing infinite loop');
        return false;
      }
    }

    // Set delegation depth tracking
    process.env._ELIZA_CLI_DELEGATION_DEPTH = '1';

    // Delegate to local CLI
    await delegateToLocalCli(localCliPath);
    return true;
  } catch (error) {
    logger.error('Error during local CLI delegation:', error);
    logger.info('Falling back to global CLI installation');
    return false;
  }
}

/**
 * Checks if a local CLI installation is available
 * @returns true if local CLI exists, false otherwise
 */
export function hasLocalCli(): boolean {
  return getLocalCliPath() !== null;
}

/**
 * Gets information about the current CLI execution context
 * @returns object with CLI execution context information
 */
export function getCliContext(): {
  isLocal: boolean;
  hasLocal: boolean;
  localPath: string | null;
  currentPath: string;
} {
  return {
    isLocal: isRunningFromLocalCli(),
    hasLocal: hasLocalCli(),
    localPath: getLocalCliPath(),
    currentPath: process.argv[1] || 'unknown',
  };
}
