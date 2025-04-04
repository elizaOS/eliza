import { logger } from '@elizaos/core';
import { Command } from 'commander';
import { getVersion, displayBanner } from '../displayBanner';
import { execa } from 'execa';
import {
  getPackageManager,
  getInstallCommand,
  isGlobalInstallation,
} from '../utils/package-manager';

export const updateCLI = new Command('update-cli')
  .description('Update the ElizaOS CLI')
  .action(async () => {
    logger.info('Checking for ElizaOS CLI updates...');

    try {
      // get the current version
      const currentVersion = getVersion();

      // determine which version stream we're on
      const versionStream = currentVersion.includes('beta')
        ? '@beta'
        : currentVersion.includes('alpha')
          ? '@alpha'
          : '@latest';

      // Determine which package manager to use
      const packageManager = getPackageManager();

      // Always install globally for update-cli
      const isGlobal = true;

      // Get the appropriate install command
      const installCommand = getInstallCommand(packageManager, isGlobal);

      logger.debug(`Using package manager: ${packageManager}`);

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
        return;
      }

      logger.info(`Updating ElizaOS CLI from ${cleanCurrentVersion} to ${latestVersion}...`);

      // perform the update using the correct package manager
      await execa(packageManager, [...installCommand, `@elizaos/cli${versionStream}`]);

      displayBanner();
      logger.info('ElizaOS CLI has been successfully updated!');
    } catch (error) {
      logger.error('Failed to update ElizaOS CLI:', error);
      throw error;
    }
  });
