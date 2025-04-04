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
      logger.info('ElizaOS CLI is already up to date!');
      return true;
    }

    logger.info(`Updating ElizaOS CLI from ${cleanCurrentVersion} to ${latestVersion}...`);

    // Always install globally for CLI updates
    await executeInstallation('@elizaos/cli', versionStream, true);

    displayBanner();
    logger.info('ElizaOS CLI has been successfully updated!');
    return true;
  } catch (error) {
    logger.error('Failed to update ElizaOS CLI:', error);
    return false;
  }
}

export const updateCLI = new Command('update-cli')
  .description('Update the ElizaOS CLI')
  .action(async () => {
    // Don't run update-cli when using npx or bunx - doesn't make sense to update a temporary CLI
    if (isRunningViaNpx() || isRunningViaBunx()) {
      logger.warn('Update command is not available when running via npx or bunx.');
      logger.info('To install the latest version, run: npm install -g @elizaos/cli');
      return;
    }

    // Only allow updates when installed as a global package
    if (!isGlobalInstallation()) {
      logger.warn('The update command is only available for globally installed CLI.');
      logger.info('To update a local installation, use your package manager manually.');
      return;
    }

    logger.info('Checking for ElizaOS CLI updates...');

    try {
      await performCliUpdate();
    } catch (error) {
      // Error already logged in performCliUpdate
      process.exit(1);
    }
  });
