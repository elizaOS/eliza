import { bunExec, bunExecInherit } from './bun-exec';
import { displayBunInstallationTipCompact } from './bun-installation-helper';

/**
 * Asynchronously runs a 'bun' command with the provided arguments in the specified directory.
 * @param {string[]} args - The arguments to pass to the 'bun' command.
 * @param {string} cwd - The current working directory in which to run the command.
 * @returns {Promise<void>} A Promise that resolves when the command has finished running.
 */
export async function runBunCommand(args: string[], cwd: string, silent = false): Promise<void> {
  const finalArgs = [...args];

  // In CI environments, optimize bun install with appropriate flags
  const isInstallCommand = args[0] === 'install';
  const isCI = process.env.CI || process.env.ELIZA_TEST_MODE === 'true';

  if (isCI && isInstallCommand) {
    // Use flags that actually exist in Bun to optimize CI installations
    if (!finalArgs.includes('--frozen-lockfile')) {
      finalArgs.push('--frozen-lockfile'); // Prevent lockfile changes in CI
    }
    console.info('✅ Using CI-optimized flags for faster installation...');
  }

  try {
    const result = silent
      ? await bunExec('bun', finalArgs, { cwd })
      : await bunExecInherit('bun', finalArgs, { cwd });

    // Using result.success for clarity - it's a boolean that indicates exitCode === 0
    if (silent && !result.success) {
      throw new Error(
        `Bun command failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`
      );
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
      const retryResult = silent
        ? await bunExec('bun', args, { cwd })
        : await bunExecInherit('bun', args, { cwd });

      // Using result.success for clarity - it's a boolean that indicates exitCode === 0
      if (silent && !retryResult.success) {
        throw new Error(
          `Bun command failed with exit code ${retryResult.exitCode}: ${retryResult.stderr || retryResult.stdout}`
        );
      }
    } else {
      throw error;
    }
  }
}
