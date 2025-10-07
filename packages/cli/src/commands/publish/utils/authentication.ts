import { bunExecSimple, bunExecInherit } from '../../../utils/bun-exec.js';
import * as clack from '@clack/prompts';

/**
 * Get or prompt for NPM username and ensure authentication
 */
export async function getNpmUsername(): Promise<string> {
  console.info(
    'NPM authentication required for registry compliance (package name must match potential NPM package).'
  );

  try {
    // Check if already logged in
    const { stdout } = await bunExecSimple('npm', ['whoami']);
    const currentUser = stdout.trim();
    console.info(`Found existing NPM login: ${currentUser}`);

    // Ask if they want to use this account or login with a different one
    const useExisting = await clack.confirm({
      message: `Use NPM account "${currentUser}" for package naming?`,
      initialValue: true,
    });

    if (clack.isCancel(useExisting)) {
      clack.cancel('Operation cancelled.');
      process.exit(0);
    }

    if (useExisting) {
      return currentUser;
    } else {
      // They want to use a different account, prompt for login
      console.info('Please login with your desired NPM account...');
      await bunExecInherit('npm', ['login']);

      // Get the new username after login
      const { stdout: newStdout } = await bunExecSimple('npm', ['whoami']);
      const newUser = newStdout.trim();
      console.info(`Logged in as: ${newUser}`);
      return newUser;
    }
  } catch (error) {
    // Not logged in, prompt for login
    console.info('Not logged into NPM. Please login to continue...');
    try {
      await bunExecInherit('npm', ['login']);

      // Get username after successful login
      const { stdout } = await bunExecSimple('npm', ['whoami']);
      const username = stdout.trim();
      console.info(`Successfully logged in as: ${username}`);
      return username;
    } catch (loginError) {
      console.error('NPM login failed. Registry compliance requires a valid NPM account.');
      process.exit(1);
    }
  }
}
