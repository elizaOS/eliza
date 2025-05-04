import { logger } from '@elizaos/core';
import { Command } from 'commander';
import { getVersion, displayBanner } from '@/src/utils';
import { execa } from 'execa';
import {
  isGlobalInstallation,
  isRunningViaNpx,
  isRunningViaBunx,
  executeInstallation,
} from '@/src/utils';

/**
 * Updates the CLI to the latest version based on the most recently published version
 * @returns {Promise<boolean>} Whether the update was successful
 */
export async function performCliUpdate(): Promise<boolean> {
  try {
    // get the current version
    const currentVersion = getVersion();

    // Get the time data for all published versions to find the most recent
    const { stdout } = await execa('npm', ['view', '@elizaos/cli', 'time', '--json']);
    const timeData = JSON.parse(stdout);

    // Remove metadata entries like 'created' and 'modified'
    delete timeData.created;
    delete timeData.modified;

    // Find the most recently published version
    let latestVersion = '';
    let latestDate = new Date(0); // Start with epoch time

    for (const [version, dateString] of Object.entries(timeData)) {
      const publishDate = new Date(dateString as string);
      if (publishDate > latestDate) {
        latestDate = publishDate;
        latestVersion = version;
      }
    }

    // If we couldn't determine the latest version or already at latest, exit
    if (!latestVersion || currentVersion === latestVersion) {
      displayBanner();
      console.info('ElizaOS CLI is already up to date!');
      return true;
    }

    console.info(`Updating ElizaOS CLI from ${currentVersion} to ${latestVersion}...`);

    // Install the specified version globally - use specific version instead of tag
    logger.info(`Updating Eliza CLI to version: ${latestVersion}`);
    try {
      // Use executeInstallation to install the CLI package with exact version
      const installResult = await executeInstallation(
        '@elizaos/cli',
        latestVersion, // The specific version number
        process.cwd(), // Specify CWD, actual install location depends on PM/global flag
        { tryNpm: true, tryGithub: false, tryMonorepo: false } // Prioritize npm
      );

      // Check the success flag from the returned object
      if (!installResult.success) {
        // Throw an error if the installation wasn't successful
        throw new Error(
          `Installation of @elizaos/cli version ${latestVersion} failed. Check logs.`
        );
      }

      logger.info(`Successfully updated Eliza CLI to ${latestVersion}`);
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
