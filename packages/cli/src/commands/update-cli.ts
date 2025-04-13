import { logger } from '@elizaos/core';
import { Command } from 'commander';
import { getVersion, displayBanner } from '../displayBanner';
import { execa } from 'execa';
import {
  isGlobalInstallation,
  isRunningViaNpx,
  isRunningViaBunx,
  executeInstallation,
} from '../utils/package-manager';

/**
 * Updates the CLI to the latest version based on the current stream (beta/alpha/latest)
 * @returns {Promise<boolean>} Whether the update was successful
 */
async function performCliUpdate(): Promise<boolean> {
  try {
    // get the current version
    const currentVersion = getVersion();

    // determine which version stream we're on
    const versionStream = currentVersion.includes('beta')
      ? '@beta'
      : currentVersion.includes('alpha')
        ? '@alpha'
        : '@latest';

    // get the latest version from npm (always use npm for version checking)
    const { stdout: latestVersion } = await execa('npm', [
      'view',
      `@elizaos/cli${versionStream}`,
      'version',
    ]);

    // compare versions (strip any @beta/@alpha suffix for comparison)
    const cleanCurrentVersion = currentVersion.split('@')[0];

    if (cleanCurrentVersion === latestVersion) {
      displayBanner();
      console.info('ElizaOS CLI is already up to date!');
      return true;
    }

    console.info(`Updating ElizaOS CLI from ${cleanCurrentVersion} to ${latestVersion}...`);

    // Install the specified version globally
    logger.info(`Updating Eliza CLI to version: ${versionStream}`);
    try {
      // Use executeInstallation to install the CLI package
      const installResult = await executeInstallation(
        '@elizaos/cli',
        versionStream, // The specific version or tag to install
        process.cwd(), // Specify CWD, actual install location depends on PM/global flag
        { tryNpm: true, tryGithub: false, tryMonorepo: false } // Prioritize npm
      );

      // Check the success flag from the returned object
      if (!installResult.success) {
        // Throw an error if the installation wasn't successful
        throw new Error(
          `Installation of @elizaos/cli version ${versionStream} failed. Check logs.`
        );
      }

      logger.info(`Successfully updated Eliza CLI to ${versionStream}`);
      logger.info('Please restart your terminal for the changes to take effect.');
    } catch (error) {
      logger.error('Failed to update Eliza CLI:', error.message);
      // logger.debug('Error details:', error);
      process.exit(1);
    }

    displayBanner();
    console.info('ElizaOS CLI has been successfully updated!');
    return true;
  } catch (error) {
    console.error('Failed to update ElizaOS CLI:', error);
    return false;
  }
}

export const updateCLI = new Command('update-cli')
  .description('Update the ElizaOS CLI')
  .action(async () => {
    // Don't run update-cli when using npx or bunx - doesn't make sense to update a temporary CLI
    if (isRunningViaNpx() || isRunningViaBunx()) {
      console.warn('Update command is not available when running via npx or bunx.');
      console.info('To install the latest version, run: npm install -g @elizaos/cli');
      return;
    }

    // Only allow updates when installed as a global package
    if (!isGlobalInstallation()) {
      console.warn('The update command is only available for globally installed CLI.');
      console.info('To update a local installation, use your package manager manually.');
      return;
    }

    console.info('Checking for ElizaOS CLI updates...');

    try {
      await performCliUpdate();
    } catch (error) {
      // Error already logged in performCliUpdate
      process.exit(1);
    }
  });
