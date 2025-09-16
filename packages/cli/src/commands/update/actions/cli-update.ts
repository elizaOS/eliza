import { isCliInstalledViaNpm, migrateCliToBun } from '@/src/utils/cli-bun-migration';
import { logger } from '@elizaos/core';
import { bunExecInherit, bunExecSimple } from '@/src/utils/bun-exec';
import { GlobalUpdateOptions } from '../types';
import { checkVersionNeedsUpdate, fetchLatestVersion, getVersion } from '../utils/version-utils';
import { getVersionChannel } from '@/src/utils/version-channel';

// --- Utility: Get latest CLI version for specific channel ---
async function getLatestCliVersionForChannel(currentVersion: string): Promise<string | null> {
  try {
    // Determine the channel of the current version
    const currentChannel = getVersionChannel(currentVersion);

    // Get the time data for all published versions to find the most recent
    const { stdout } = await bunExecSimple('npm', ['view', '@elizaos/cli', 'time', '--json']);
    const timeData = JSON.parse(stdout);

    // Remove metadata entries like 'created' and 'modified'
    delete timeData.created;
    delete timeData.modified;

    // Filter versions by channel and find the most recently published version
    let latestVersion = '';
    let latestDate = new Date(0); // Start with epoch time

    for (const [version, dateString] of Object.entries(timeData)) {
      // Skip versions from different channels
      if (getVersionChannel(version) !== currentChannel) {
        continue;
      }

      const publishDate = new Date(dateString as string);
      if (publishDate > latestDate) {
        latestDate = publishDate;
        latestVersion = version;
      }
    }

    return latestVersion || null;
  } catch {
    return null;
  }
}

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
      // Use channel-aware version checking
      const fetchedVersion = await getLatestCliVersionForChannel(currentVersion);
      if (!fetchedVersion) {
        // Fall back to standard latest version if channel detection fails
        const fallbackVersion = await fetchLatestVersion('@elizaos/cli');
        if (!fallbackVersion) {
          throw new Error('Unable to fetch latest CLI version');
        }
        latestVersion = fallbackVersion;
      } else {
        latestVersion = fetchedVersion;
      }
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
          logger.debug(
            'Migration error:',
            migrationError instanceof Error ? migrationError.message : String(migrationError)
          );
          // Fallback to npm installation since bun failed
          try {
            await bunExecInherit('npm', ['install', '-g', `@elizaos/cli@${latestVersion}`]);
            console.log(`CLI updated successfully to version ${latestVersion} [✓]`);
            return true;
          } catch (npmError) {
            throw new Error(
              `Both bun migration and npm fallback failed. Bun: ${migrationError instanceof Error ? migrationError.message : String(migrationError)}, npm: ${npmError instanceof Error ? npmError.message : String(npmError)}`
            );
          }
        }
      }
    }

    // Standard bun installation (no npm installation detected or migration skipped)
    try {
      await bunExecInherit('bun', ['add', '-g', `@elizaos/cli@${latestVersion}`]);
      console.log(`CLI updated successfully to version ${latestVersion} [✓]`);
      return true;
    } catch (bunError) {
      console.error('Bun installation not found. Please install bun first:');
      console.error('  curl -fsSL https://bun.sh/install | bash');
      console.error('  # or');
      console.error('  npm install -g bun');
      logger.debug(
        { error: bunError instanceof Error ? bunError.message : String(bunError) },
        'Bun error:'
      );
      return false;
    }
  } catch (error) {
    console.error(`CLI update failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
