import { logger } from '@elizaos/core';
import { Command } from 'commander';
import { getVersion, displayBanner } from '../displayBanner';
import { execa } from 'execa';

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

      // get the latest version from npm
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

      // perform the update based on version stream
      await execa('npm', ['install', '-g', `@elizaos/cli${versionStream}`]);

      displayBanner();
      logger.info('ElizaOS CLI has been successfully updated!');
    } catch (error) {
      logger.error('Failed to update ElizaOS CLI:', error);
      throw error;
    }
  });
