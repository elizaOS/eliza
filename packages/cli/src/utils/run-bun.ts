import { execa } from 'execa';
import { displayBunInstallationTipCompact } from './bun-installation-helper';

/**
 * Asynchronously runs a 'bun' command with the provided arguments in the specified directory.
 * @param {string[]} args - The arguments to pass to the 'bun' command.
 * @param {string} cwd - The current working directory in which to run the command.
 * @param {object} options - Optional configuration for the command.
 * @returns {Promise<void>} A Promise that resolves when the command has finished running.
 */
export async function runBunCommand(
  args: string[], 
  cwd: string, 
  options?: { preferOffline?: boolean }
): Promise<void> {
  const finalArgs = [...args];
  
  // In CI environments, optimize bun install with appropriate flags
  const isInstallCommand = args[0] === 'install' || args[0] === 'add';
  const isCI = process.env.CI || process.env.ELIZA_TEST_MODE === 'true';
  
  console.log(`[DEBUG] runBunCommand: args=${JSON.stringify(args)}, isInstallCommand=${isInstallCommand}, isCI=${isCI}, CI=${process.env.CI}, ELIZA_TEST_MODE=${process.env.ELIZA_TEST_MODE}`);
  
  if (isCI && isInstallCommand) {
    // Use flags that actually exist in Bun to optimize CI installations
    if (!finalArgs.includes('--frozen-lockfile')) {
      finalArgs.push('--frozen-lockfile');  // Prevent lockfile changes in CI
    }
    if (!finalArgs.includes('--no-install')) {
      finalArgs.push('--no-install');  // Disable auto-install to use existing packages
    }
    console.info('✅ Using CI-optimized flags for faster installation...');
    console.log(`[DEBUG] Final args: ${JSON.stringify(finalArgs)}`);
  }

  try {
    await execa('bun', finalArgs, { cwd, stdio: 'inherit' });
  } catch (error: any) {
    if (error.code === 'ENOENT' || error.message?.includes('bun: command not found')) {
      throw new Error(`Bun command not found. ${displayBunInstallationTipCompact()}`);
    }
    
    // If CI-optimized install fails, try again with basic args
    if (isCI && isInstallCommand && 
        (error.message?.includes('frozen-lockfile') || error.message?.includes('install'))) {
      console.warn('CI-optimized install failed, retrying with basic args...');
      await execa('bun', args, { cwd, stdio: 'inherit' });
    } else {
      throw error;
    }
  }
}
