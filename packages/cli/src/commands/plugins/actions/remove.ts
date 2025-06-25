import { detectDirectoryType } from '@/src/utils/directory-detection';
import { handleError } from '@/src/utils';
import { logger } from '@elizaos/core';
import { execa } from 'execa';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { findPluginPackageName } from '../utils/naming';
import { getDependenciesFromDirectory } from '../utils/directory';
import { RemovePluginOptions } from '../types';
import { loadCharacterFile, updateCharacterFile, resolveCharacterPaths } from '../utils/character-updater';

/**
 * Update character files to remove the plugin
 */
async function updateCharacterFilesForRemoval(pluginName: string, opts: RemovePluginOptions): Promise<void> {
  if (!opts.character) {
    logger.error('No character files specified. Use --character to specify character files to update.');
    process.exit(1);
  }

  const characterPaths = resolveCharacterPaths(opts.character);
  
  for (const characterPath of characterPaths) {
    try {
      const characterFile = await loadCharacterFile(characterPath);
      await updateCharacterFile(characterFile, pluginName, 'remove');
      logger.info(`✅ Removed plugin '${pluginName}' from character '${characterFile.character.name}'`);
    } catch (error) {
      logger.error(`Failed to update character file ${characterPath}:`, error);
      process.exit(1);
    }
  }
}

/**
 * Remove a plugin from the project and character files
 */
export async function removePlugin(plugin: string, opts: RemovePluginOptions): Promise<void> {
  // Validate character option
  if (!opts.character || (Array.isArray(opts.character) && opts.character.length === 0)) {
    logger.error('No character files specified.');
    logger.info('Use --character to specify one or more character files to update.');
    logger.info('Example: elizaos plugins remove openrouter --character ./characters/my-agent.json');
    process.exit(1);
  }

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
    logger.info('The plugin may have already been removed from package.json.');
    logger.info('Attempting to remove from character files anyway...');
    
    // Try to remove from character files even if not in package.json
    await updateCharacterFilesForRemoval(plugin, opts);
    process.exit(0);
  }

  // First update character files
  logger.info(`Removing plugin from character files...`);
  await updateCharacterFilesForRemoval(packageNameToRemove, opts);

  // Then remove from package.json
  console.info(`Removing ${packageNameToRemove} from package.json...`);
  try {
    await execa('bun', ['remove', packageNameToRemove], {
      cwd,
      stdio: 'inherit',
    });
  } catch (execError) {
    logger.error(
      `Failed to run 'bun remove ${packageNameToRemove}': ${execError instanceof Error ? execError.message : String(execError)}`
    );
    if (
      execError &&
      typeof execError === 'object' &&
      'stderr' in execError &&
      typeof execError.stderr === 'string' &&
      execError.stderr.includes('not found')
    ) {
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
  if (existsSync(pluginDir)) {
    try {
      rmSync(pluginDir, { recursive: true, force: true });
    } catch (rmError) {
      logger.error(
        `Failed to remove directory ${pluginDir}: ${rmError instanceof Error ? rmError.message : String(rmError)}`
      );
    }
  } else {
    const nonPrefixedDir = path.join(cwd, baseName);
    if (existsSync(nonPrefixedDir)) {
      try {
        rmSync(nonPrefixedDir, { recursive: true, force: true });
      } catch (rmError) {
        logger.error(
          `Failed to remove directory ${nonPrefixedDir}: ${rmError instanceof Error ? rmError.message : String(rmError)}`
        );
      }
    }
  }

  console.log(`Successfully removed ${packageNameToRemove}`);
}
