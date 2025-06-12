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
  
  // In CI environments, automatically use offline mode for install-related commands
  const isInstallCommand = args[0] === 'install' || args[0] === 'add';
  const isCI = process.env.CI || process.env.ELIZA_TEST_MODE === 'true';
  
  if (isCI && isInstallCommand && !finalArgs.includes('--prefer-offline')) {
    finalArgs.push('--prefer-offline');
    console.info('Using prefer-offline mode for faster installation from cache...');
  }

  try {
    await execa('bun', finalArgs, { cwd, stdio: 'inherit' });
  } catch (error: any) {
    if (error.code === 'ENOENT' || error.message?.includes('bun: command not found')) {
      throw new Error(`Bun command not found. ${displayBunInstallationTipCompact()}`);
    }
    
    // If prefer-offline mode fails, try again without prefer-offline flag
    if (isCI && isInstallCommand && 
        (error.message?.includes('offline') || error.message?.includes('prefer-offline'))) {
      console.warn('Prefer-offline install failed, retrying with network access...');
      await execa('bun', args, { cwd, stdio: 'inherit' });
    } else {
      throw error;
    }
  }
}
