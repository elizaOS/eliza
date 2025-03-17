import { execa } from 'execa';

/**
 * Asynchronously runs a 'bun' command with the provided arguments in the specified directory.
 * @param {string[]} args - The arguments to pass to the 'bun' command.
 * @param {string} cwd - The current working directory in which to run the command.
 * @returns {Promise<void>} A Promise that resolves when the command has finished running.
 */
export async function runBunCommand(args: string[], cwd: string): Promise<void> {
  await execa('bun', args, { cwd, stdio: 'inherit' });
}
