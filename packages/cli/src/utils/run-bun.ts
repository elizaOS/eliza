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
  try {
    const finalArgs = [...args];
    
    // In CI environments, prefer offline mode for install commands to use cached packages
    if (options?.preferOffline && 
        (process.env.CI || process.env.ELIZA_TEST_MODE === 'true') &&
        args[0] === 'install') {
      finalArgs.push('--offline');
      console.info('Using offline mode for faster installation from cache...');
    }
    
    await execa('bun', finalArgs, { cwd, stdio: 'inherit' });
  } catch (error: any) {
    if (error.code === 'ENOENT' || error.message?.includes('bun: command not found')) {
      throw new Error(`Bun command not found. ${displayBunInstallationTipCompact()}`);
    }
    
    // If offline mode fails, try again without offline flag
    if (options?.preferOffline && 
        args[0] === 'install' && 
        error.message?.includes('offline')) {
      console.warn('Offline install failed, retrying with network access...');
      await execa('bun', args, { cwd, stdio: 'inherit' });
    } else {
      throw error;
    }
  }
}
