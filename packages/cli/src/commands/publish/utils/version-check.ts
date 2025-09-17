import * as clack from '@clack/prompts';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLatestCliVersionForChannel } from '@/src/utils/version-channel';
import { performCliUpdate } from '@/src/commands/update/actions/cli-update';

/**
 * Check if the current CLI version is up to date
 */
export async function checkCliVersion(): Promise<string> {
  try {
    const cliPackageJsonPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../package.json'
    );

    const cliPackageJsonContent = await fs.readFile(cliPackageJsonPath, 'utf-8');
    const cliPackageJson = JSON.parse(cliPackageJsonContent);
    const currentVersion = cliPackageJson.version || '0.0.0';

    // Use the shared utility to get the latest version for the channel
    const latestVersion = await getLatestCliVersionForChannel(currentVersion);

    // Compare versions
    if (latestVersion && latestVersion !== currentVersion) {
      console.warn(`CLI update available: ${currentVersion} → ${latestVersion}`);

      const update = await clack.confirm({
        message: 'Update CLI before publishing?',
        initialValue: false,
      });

      if (clack.isCancel(update)) {
        clack.cancel('Operation cancelled.');
        process.exit(0);
      }

      if (update) {
        console.info('Updating CLI...');
        // Instead of using npx (which gets blocked), directly call the update function
        try {
          await performCliUpdate();
          // If update is successful, exit
          process.exit(0);
        } catch (updateError) {
          console.error('Failed to update CLI:', updateError);
          // Continue with current version if update fails
        }
      }
    }

    return currentVersion;
  } catch (error) {
    console.warn('Could not check for CLI updates');
    return '0.0.0';
  }
}
