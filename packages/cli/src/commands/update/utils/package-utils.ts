import fs from 'node:fs/promises';
import { bunExecInherit } from '@/src/utils/bun-exec';
import { logger } from '@elizaos/core';
import { getPackageManager } from '@/src/utils';
import { UpdateCheckResult, PackageUpdate } from '../types';
import {
  checkVersionNeedsUpdate,
  fetchLatestVersion,
  ELIZAOS_ORG,
  isWorkspaceVersion,
  isMajorUpdate,
} from './version-utils';

/**
 * Check for available updates
 */
export async function checkForUpdates(
  dependencies: Record<string, string>
): Promise<UpdateCheckResult> {
  const updates: Record<string, PackageUpdate> = {};
  const elizaPackages = Object.entries(dependencies)
    .filter(([pkg]) => pkg.startsWith(ELIZAOS_ORG))
    .filter(([, version]) => !isWorkspaceVersion(version));

  for (const [pkg, currentVersion] of elizaPackages) {
    const latestVersion = await fetchLatestVersion(pkg);
    if (!latestVersion) continue;

    const { needsUpdate, error } = checkVersionNeedsUpdate(currentVersion, latestVersion);
    if (needsUpdate) {
      updates[pkg] = { current: currentVersion, latest: latestVersion };
    } else if (error) {
      logger.debug(`${pkg}: ${error}`);
    }
  }

  return { hasUpdates: Object.keys(updates).length > 0, updates };
}

/**
 * Display update summary
 */
export function displayUpdateSummary(updates: Record<string, PackageUpdate>) {
  console.log('\nAvailable updates:');
  Object.entries(updates).forEach(([pkg, { current, latest }]) => {
    const majorUpdate = isMajorUpdate(current, latest);
    const updateType = majorUpdate ? ' (MAJOR)' : '';
    console.log(`  ${pkg}: ${current} → ${latest}${updateType}`);
  });
}

/**
 * Update package.json with new versions
 */
export async function updatePackageJson(
  packageJsonPath: string,
  updates: Record<string, PackageUpdate>
) {
  const content = await fs.readFile(packageJsonPath, 'utf8');
  const packageJson = JSON.parse(content);

  let modified = false;
  for (const [pkg, { latest }] of Object.entries(updates)) {
    if (packageJson.dependencies?.[pkg]) {
      packageJson.dependencies[pkg] = `^${latest}`;
      modified = true;
    }
    if (packageJson.devDependencies?.[pkg]) {
      packageJson.devDependencies[pkg] = `^${latest}`;
      modified = true;
    }
  }

  if (modified) {
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
    console.log('Updated package.json with new versions');
  }
}

/**
 * Install dependencies using the detected package manager
 */
export async function installDependencies(cwd: string): Promise<void> {
  console.log('\nInstalling updated packages...');
  try {
    const packageManager = await getPackageManager();
    await bunExecInherit(packageManager, ['install'], { cwd });
    console.log('Dependencies installed successfully [✓]');
  } catch (error) {
    throw new Error(
      `Failed to install dependencies: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
