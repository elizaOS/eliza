import { execa } from 'execa';
import { displayBunInstallationTipCompact } from './bun-installation-helper';

/**
 * Asynchronously runs a 'bun' command with the provided arguments in the specified directory.
 * @param {string[]} args - The arguments to pass to the 'bun' command.
 * @param {string} cwd - The current working directory in which to run the command.
 * @returns {Promise<void>} A Promise that resolves when the command has finished running.
 */
export async function runBunCommand(args: string[], cwd: string): Promise<void> {
  try {
    await execa('bun', args, { cwd, stdio: 'inherit' });
  } catch (error: any) {
    if (error.code === 'ENOENT' || error.message?.includes('bun: command not found')) {
      throw new Error(`Bun command not found. ${displayBunInstallationTipCompact()}`);
    }
    throw error;
  }
}
