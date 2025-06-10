import { buildProject } from '@/src/utils';
import * as clack from '@clack/prompts';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { UpdateOptions } from '../types';
import {
  checkForUpdates,
  displayUpdateSummary,
  installDependencies,
  updatePackageJson,
} from '../utils/package-utils';
import { isMajorUpdate } from '../utils/version-utils';

/**
 * Main dependency update function
 *
 * Updates ElizaOS dependencies in a project or plugin, with support for dry-run mode, major version confirmation, and optional build step.
 */
export async function updateDependencies(
  cwd: string,
  isPlugin: boolean,
  options: UpdateOptions = {}
): Promise<void> {
  const { dryRun = false, skipBuild = false } = options;

  const packageJsonPath = path.join(cwd, 'package.json');
  const content = await fs.readFile(packageJsonPath, 'utf8');
  const packageJson = JSON.parse(content);

  const allDependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  // Check for updates
  const { hasUpdates, updates } = await checkForUpdates(allDependencies);

  if (!hasUpdates) {
    console.log('All ElizaOS packages are up to date! [✓]');
    return;
  }

  displayUpdateSummary(updates);

  if (dryRun) {
    console.log('\nTo apply these updates, run: elizaos update');
    return;
  }

  // Check for major updates
  const hasMajorUpdates = Object.entries(updates).some(([, { current, latest }]) =>
    isMajorUpdate(current, latest)
  );

  if (hasMajorUpdates) {
    const confirmMajor = await clack.confirm({
      message: 'This update includes major version changes. Continue?',
      initialValue: false,
    });

    if (clack.isCancel(confirmMajor)) {
      clack.cancel('Operation cancelled.');
      process.exit(0);
    }

    if (!confirmMajor) {
      console.log('Update cancelled');
      return;
    }
  }

  // Update package.json
  await updatePackageJson(packageJsonPath, updates);

  // Install dependencies
  await installDependencies(cwd);

  // Build if not skipped
  if (!skipBuild) {
    console.log('\nBuilding project...');
    await buildProject(cwd, isPlugin);
    console.log('Build completed successfully [✓]');
  }
}
