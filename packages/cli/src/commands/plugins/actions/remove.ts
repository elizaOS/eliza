import { detectDirectoryType } from '@/src/utils/directory-detection';
import { handleError } from '@/src/utils';
import { logger } from '@elizaos/core';
import { execa } from 'execa';
import fs from 'node:fs';
import path from 'node:path';
import { findPluginPackageName } from '../utils/naming';
import { getDependenciesFromDirectory } from '../utils/directory';

/**
 * Remove a plugin from the project
 */
export async function removePlugin(plugin: string): Promise<void> {
  const cwd = process.cwd();
  const directoryInfo = detectDirectoryType(cwd);

  if (!directoryInfo || !directoryInfo.hasPackageJson) {
    console.error(
      `Could not read or parse package.json. This directory is: ${directoryInfo?.type || 'invalid or inaccessible'}`
    );
    process.exit(1);
  }

  const allDependencies = getDependenciesFromDirectory(cwd);
  if (!allDependencies) {
    console.error(
      'Could not read dependencies from package.json. Cannot determine which package to remove.'
    );
    process.exit(1);
  }

  const packageNameToRemove = findPluginPackageName(plugin, allDependencies);

  if (!packageNameToRemove) {
    logger.warn(`Plugin matching "${plugin}" not found in project dependencies.`);
    console.info('\nCheck installed plugins using: elizaos project installed-plugins');
    process.exit(0);
  }

  console.info(`Removing ${packageNameToRemove}...`);
  try {
    await execa('bun', ['remove', packageNameToRemove], {
      cwd,
      stdio: 'inherit',
    });
  } catch (execError) {
    logger.error(`Failed to run 'bun remove ${packageNameToRemove}': ${execError.message}`);
    if (execError.stderr?.includes('not found')) {
      logger.info(
        `'bun remove' indicated package was not found. Continuing with directory removal attempt.`
      );
    } else {
      handleError(execError);
      process.exit(1);
    }
  }

  // Remove plugin directory if it exists
  let baseName = packageNameToRemove;
  if (packageNameToRemove.includes('/')) {
    const parts = packageNameToRemove.split('/');
    baseName = parts[parts.length - 1];
  }
  baseName = baseName.replace(/^plugin-/, '');
  const dirNameToRemove = `plugin-${baseName}`;

  const pluginDir = path.join(cwd, dirNameToRemove);
  if (fs.existsSync(pluginDir)) {
    try {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    } catch (rmError) {
      logger.error(`Failed to remove directory ${pluginDir}: ${rmError.message}`);
    }
  } else {
    const nonPrefixedDir = path.join(cwd, baseName);
    if (fs.existsSync(nonPrefixedDir)) {
      try {
        fs.rmSync(nonPrefixedDir, { recursive: true, force: true });
      } catch (rmError) {
        logger.error(`Failed to remove directory ${nonPrefixedDir}: ${rmError.message}`);
      }
    }
  }

  console.log(`Successfully removed ${packageNameToRemove}`);
}