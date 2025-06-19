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
  [key: string]: any;
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
    logger.debug(`Failed to parse package.json: ${error}`);
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

    logger.debug(`Detected local plugin development: ${pluginName}`);
    logger.debug(`Expected output: ${localPath}`);
    logger.debug(`Needs build: ${needsBuild}`);

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
    logger.info('Plugin not built, attempting to build...');
    try {
      await buildProject(process.cwd(), true);

      // Verify the build created the expected output
      if (localPath && existsSync(localPath)) {
        logger.success('Plugin built successfully');
        return true;
      } else {
        logger.error(`Build completed but expected output not found: ${localPath}`);
        return false;
      }
    } catch (error) {
      logger.error(`Build failed: ${error}`);
      return false;
    }
  }

  logger.error(`Plugin not built and no build script found in package.json`);
  logger.info(`Add a "build" script to package.json or run 'bun run build' manually`);
  return false;
}

/**
 * Provides helpful guidance when local plugin loading fails
 */
export function provideLocalPluginGuidance(pluginName: string, context: PluginContext): void {
  if (!context.isLocalDevelopment) {
    return;
  }

  logger.info(`\nLocal plugin development detected for: ${pluginName}`);

  if (context.needsBuild) {
    logger.info('To fix this issue:');
    logger.info('1. Build the plugin: bun run build');
    logger.info('2. Verify the output exists at: ' + context.localPath);
    logger.info('3. Re-run the test command');
  } else {
    logger.info('Plugin appears to be built but failed to load.');
    logger.info('Try rebuilding: bun run build');
  }

  logger.info('\nFor more information, see the plugin development guide.');
}
