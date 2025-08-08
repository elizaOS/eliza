import { bunExecSimple } from '../../../utils/bun-exec.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as clack from '@clack/prompts';
import { performCliUpdate } from '../../update';

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

    // Get the time data for all published versions to find the most recent
    const { stdout } = await bunExecSimple('npm', ['view', '@elizaos/cli', 'time', '--json']);
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
