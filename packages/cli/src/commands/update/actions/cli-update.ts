import { executeInstallation } from '@/src/utils';
import { isCliInstalledViaNpm, migrateCliToBun } from '@/src/utils/cli-bun-migration';
import { logger } from '@elizaos/core';
import { execa } from 'execa';
import { GlobalUpdateOptions } from '../types';
import { checkVersionNeedsUpdate, fetchLatestVersion, getVersion } from '../utils/version-utils';

/**
 * Update CLI to latest version
 *
 * Handles CLI updates with automatic migration from npm to bun when appropriate, and supports both global and local installation scenarios.
 */
export async function performCliUpdate(options: GlobalUpdateOptions = {}): Promise<boolean> {
  try {
    const currentVersion = await getVersion();
    const targetVersion = options.version || 'latest';

    let latestVersion: string;
    if (targetVersion === 'latest') {
      const fetchedVersion = await fetchLatestVersion('@elizaos/cli');
      if (!fetchedVersion) {
        throw new Error('Unable to fetch latest CLI version');
      }
      latestVersion = fetchedVersion;
    } else {
      latestVersion = targetVersion;
    }

    const { needsUpdate } = checkVersionNeedsUpdate(currentVersion, latestVersion);
    if (!needsUpdate) {
      console.log(`CLI is already at the latest version (${currentVersion}) [✓]`);
      return true;
    }

    console.log(`Updating CLI from ${currentVersion} to ${latestVersion}...`);

    // Check if CLI is installed via npm and migrate to bun (unless skipped)
    if (!options.skipBunMigration) {
      const npmInstallation = await isCliInstalledViaNpm();
      if (npmInstallation) {
        logger.info('Detected npm installation, migrating to bun...');
        try {
          await migrateCliToBun(latestVersion);
          console.log(`CLI updated successfully to version ${latestVersion} [✓]`);
          return true;
        } catch (migrationError) {
          logger.warn('Migration to bun failed, falling back to npm update...');
          logger.debug('Migration error:', migrationError.message);
          // Fallback to npm installation since bun failed
          try {
            await execa('npm', ['install', '-g', `@elizaos/cli@${latestVersion}`], {
              stdio: 'inherit',
            });
            console.log(`CLI updated successfully to version ${latestVersion} [✓]`);
            return true;
          } catch (npmError) {
            throw new Error(
              `Both bun migration and npm fallback failed. Bun: ${migrationError.message}, npm: ${npmError.message}`
            );
          }
        }
      }
    }

    // Standard bun installation (no npm installation detected or migration skipped)
    await executeInstallation('@elizaos/cli', latestVersion, process.cwd());
    console.log(`CLI updated successfully to version ${latestVersion} [✓]`);
    return true;
  } catch (error) {
    console.error(`CLI update failed: ${error.message}`);
    return false;
  }
}
