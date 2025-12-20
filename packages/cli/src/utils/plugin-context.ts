import { logger } from '@elizaos/core';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildProject } from './build-project';
import { normalizePluginName } from './registry';
import { detectDirectoryType } from './directory-detection';

interface PackageInfo {
  name: string;
  main?: string;
  scripts?: Record<string, string>;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: string | Record<string, string> | undefined;
}

interface PluginContext {
  isLocalDevelopment: boolean;
  localPath?: string;
  packageInfo?: PackageInfo;
  needsBuild?: boolean;
}

/**
 * Normalizes plugin names for comparison by removing common prefixes and scopes
 */
function normalizeForComparison(name: string): string {
  const normalized = normalizePluginName(name)[0] || name;
  return normalized.toLowerCase();
}

/**
 * Detects if the current directory is the same plugin being requested
 * and provides context about local development status
 */
export function detectPluginContext(pluginName: string): PluginContext {
  const cwd = process.cwd();

  // Use existing directory detection to check if we're in a plugin
  const directoryInfo = detectDirectoryType(cwd);

  if (directoryInfo.type !== 'elizaos-plugin' || !directoryInfo.hasPackageJson) {
    return { isLocalDevelopment: false };
  }

  // Get package info from directory detection result
  const packageJsonPath = path.join(cwd, 'package.json');
  let packageInfo: PackageInfo;
  try {
    packageInfo = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  } catch (error) {
    logger.debug({ src: 'cli', util: 'plugin-context', error }, 'Failed to parse package.json');
    return { isLocalDevelopment: false };
  }

  // Check if the requested plugin matches the current package
  const normalizedRequestedPlugin = normalizeForComparison(pluginName);
  const normalizedCurrentPackage = normalizeForComparison(packageInfo.name);

  // Also check directory name as fallback
  const dirName = path.basename(cwd);
  const normalizedDirName = normalizeForComparison(dirName);

  const isCurrentPlugin =
    normalizedRequestedPlugin === normalizedCurrentPackage ||
    normalizedRequestedPlugin === normalizedDirName;

  if (isCurrentPlugin) {
    const mainEntry = packageInfo.main || 'dist/index.js';
    const localPath = path.resolve(cwd, mainEntry);
    const needsBuild = !existsSync(localPath);

    logger.debug(
      { src: 'cli', util: 'plugin-context', pluginName, localPath, needsBuild },
      'Detected local plugin development'
    );

    return {
      isLocalDevelopment: true,
      localPath,
      packageInfo,
      needsBuild,
    };
  }

  return { isLocalDevelopment: false };
}

/**
 * Ensures a local plugin is built before attempting to load it
 */
export async function ensurePluginBuilt(context: PluginContext): Promise<boolean> {
  if (!context.isLocalDevelopment || !context.needsBuild || !context.packageInfo) {
    return true;
  }

  const { packageInfo, localPath } = context;

  // Check if build script exists
  if (packageInfo.scripts?.build) {
    logger.info({ src: 'cli', util: 'plugin-context' }, 'Plugin not built, building...');
    try {
      await buildProject(process.cwd(), true);

      // Verify the build created the expected output
      if (localPath && existsSync(localPath)) {
        logger.success({ src: 'cli', util: 'plugin-context' }, 'Plugin built successfully');
        return true;
      } else {
        logger.error(
          { src: 'cli', util: 'plugin-context', expectedPath: localPath },
          'Build completed but output not found'
        );
        return false;
      }
    } catch (error) {
      logger.error({ src: 'cli', util: 'plugin-context', error }, 'Build failed');
      return false;
    }
  }

  logger.error(
    { src: 'cli', util: 'plugin-context' },
    'Plugin not built and no build script found'
  );
  logger.info(
    { src: 'cli', util: 'plugin-context' },
    'Add a build script to package.json or run bun run build'
  );
  return false;
}

/**
 * Provides helpful guidance when local plugin loading fails
 */
export function provideLocalPluginGuidance(pluginName: string, context: PluginContext): void {
  if (!context.isLocalDevelopment) {
    return;
  }

  logger.info(
    { src: 'cli', util: 'plugin-context', pluginName },
    'Local plugin development detected'
  );

  if (context.needsBuild) {
    logger.info(
      { src: 'cli', util: 'plugin-context' },
      'To fix: 1) bun run build, 2) verify output, 3) re-run'
    );
  } else {
    logger.info(
      { src: 'cli', util: 'plugin-context' },
      'Plugin built but failed to load, try rebuilding'
    );
  }
}
