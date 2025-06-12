import { logger } from '@elizaos/core';
import fs from 'node:fs';
import path from 'node:path';
import { buildProject } from './build-project';
import { normalizePluginName } from './registry';
import { detectDirectoryType, type PackageJson } from './directory-detection';

interface PackageInfo extends PackageJson {
  main?: string;
  scripts?: Record<string, string>;
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
  const directoryInfo = detectDirectoryType(cwd);

  // If it's not a plugin directory, we're done
  if (!directoryInfo.isPlugin) {
    return { isLocalDevelopment: false };
  }

  // Now we know we're in a plugin directory, just check if it's the right one
  const normalizedRequestedPlugin = normalizeForComparison(pluginName);
  const normalizedCurrentPackage = normalizeForComparison(directoryInfo.packageName || '');
  const normalizedDirName = normalizeForComparison(path.basename(cwd));

  const isCurrentPlugin =
    normalizedRequestedPlugin === normalizedCurrentPackage ||
    normalizedRequestedPlugin === normalizedDirName;

  if (!isCurrentPlugin) {
    return { isLocalDevelopment: false };
  }

  // We're in the right plugin directory, now handle local dev specifics
  const mainEntry =
    directoryInfo.packageInfo?.main ||
    (fs.existsSync(path.join(cwd, 'dist/index.js')) ? 'dist/index.js' : 'src/index.ts');
  const localPath = path.resolve(cwd, mainEntry);
  const needsBuild = !fs.existsSync(localPath);

  logger.debug(`Detected local plugin development: ${pluginName}`);
  logger.debug(`Expected output: ${localPath}`);
  logger.debug(`Needs build: ${needsBuild}`);

  return {
    isLocalDevelopment: true,
    localPath,
    packageInfo: directoryInfo.packageInfo as PackageInfo,
    needsBuild,
  };
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
      if (localPath && fs.existsSync(localPath)) {
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
