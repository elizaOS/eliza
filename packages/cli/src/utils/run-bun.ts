import { execa } from 'execa';
import { spawn } from 'child_process';
import { displayBunInstallationTipCompact } from './bun-installation-helper';

/**
 * Asynchronously runs a 'bun' command with the provided arguments in the specified directory.
 * @param {string[]} args - The arguments to pass to the 'bun' command.
 * @param {string} cwd - The current working directory in which to run the command.
 * @returns {Promise<void>} A Promise that resolves when the command has finished running.
 */
export async function runBunCommand(args: string[], cwd: string): Promise<void> {
  const finalArgs = [...args];

  // In CI environments, optimize bun install with appropriate flags
  const isInstallCommand = args[0] === 'install' || args[0] === 'add';
  const isCI = process.env.CI || process.env.ELIZA_TEST_MODE === 'true';

  // Debug logging
  if (process.env.DEBUG || process.env.LOG_LEVEL === 'debug') {
    console.log(
      '[DEBUG] runBunCommand: args=%o, isInstallCommand=%s, isCI=%s, CI=%s, ELIZA_TEST_MODE=%s',
      args,
      isInstallCommand,
      isCI,
      process.env.CI,
      process.env.ELIZA_TEST_MODE
    );
  }

  if (isCI && isInstallCommand) {
    // Use flags that actually exist in Bun to optimize CI installations
    if (!finalArgs.includes('--frozen-lockfile')) {
      finalArgs.push('--frozen-lockfile'); // Prevent lockfile changes in CI
    }
    console.info('✅ Using CI-optimized flags for faster installation...');
  }

  // Check if we're already running under bun
  const isRunningUnderBun = process.argv[0]?.includes('bun') || process.execPath?.includes('bun');

  try {
    if (isRunningUnderBun) {
      // Use node's spawn to avoid bun-within-bun issues
      return new Promise((resolve, reject) => {
        const child = spawn('bun', finalArgs, {
          cwd,
          stdio: 'inherit',
          shell: true,
          env: {
            ...process.env,
            // Force color output
            FORCE_COLOR: '1',
          },
        });

        child.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Command failed with exit code ${code}: bun ${finalArgs.join(' ')}`));
          }
        });

        child.on('error', (error) => {
          if (error.message?.includes('ENOENT') || error.message?.includes('not found')) {
            reject(new Error(`Bun command not found. ${displayBunInstallationTipCompact()}`));
          } else {
            reject(error);
          }
        });
      });
    } else {
      // Use execa when not running under bun
      await execa('bun', finalArgs, { cwd, stdio: 'inherit' });
    }
  } catch (error: any) {
    if (error.code === 'ENOENT' || error.message?.includes('bun: command not found')) {
      throw new Error(`Bun command not found. ${displayBunInstallationTipCompact()}`);
    }

    // If CI-optimized install fails, try again with basic args
    if (
      isCI &&
      isInstallCommand &&
      (error.message?.includes('frozen-lockfile') || error.message?.includes('install'))
    ) {
      console.warn('CI-optimized install failed, retrying with basic args...');
      // Retry with the original approach
      await execa('bun', args, { cwd, stdio: 'inherit' });
    } else {
      throw error;
    }
  }
}
