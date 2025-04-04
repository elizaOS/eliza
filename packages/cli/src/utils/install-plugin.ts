import { logger } from '@elizaos/core';
import { execa } from 'execa';
import { getPluginVersion } from './registry';
import { isGlobalInstallation, getPackageManager, executeInstallation } from './package-manager';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Get the CLI's installation directory when running globally
 * @returns {string|null} - The path to the CLI's directory or null if not found
 */
function getCliDirectory(): string | null {
  try {
    // Get the path to the running CLI script
    const cliPath = process.argv[1];

    // For global installations, this will be something like:
    // /usr/local/lib/node_modules/@elizaos/cli/dist/index.js

    if (cliPath.includes('node_modules/@elizaos/cli')) {
      // Go up to the CLI package root
      const cliDir = path.dirname(
        cliPath.split('node_modules/@elizaos/cli')[0] + 'node_modules/@elizaos/cli'
      );

      // Verify this is actually the CLI directory
      if (fs.existsSync(path.join(cliDir, 'package.json'))) {
        return cliDir;
      }
    }

    return null;
  } catch (error) {
    logger.error('Failed to determine CLI directory:', error);
    return null;
  }
}

/**
 * Verifies if a plugin can be imported
 * @param {string} repository - The plugin repository/package name to import
 * @param {string} context - Description of the installation context for logging
 * @returns {boolean} - Whether the import was successful
 */
async function verifyPluginImport(repository: string, context: string): Promise<boolean> {
  try {
    // First try: direct import
    let directImportError;
    try {
      await import(repository);
      logger.info(`Successfully installed and verified plugin ${repository} ${context}`);
      return true;
    } catch (error) {
      directImportError = error;
      logger.debug(`Direct import failed: ${error.message}`);

      // Second try: check for explicit paths in node_modules
      try {
        // Try global node_modules
        const globalNodeModulesPath = path.join('/usr/local/lib/node_modules', repository);
        await import(globalNodeModulesPath);
        logger.info(`Successfully loaded plugin from global node_modules: ${repository}`);
        return true;
      } catch (globalNodeModulesError) {
        logger.debug(`Global node_modules import failed: ${globalNodeModulesError.message}`);

        // Try local node_modules
        try {
          const localNodeModulesPath = path.join(process.cwd(), 'node_modules', repository);
          await import(localNodeModulesPath);
          logger.info(`Successfully loaded plugin from local node_modules: ${repository}`);
          return true;
        } catch (localNodeModulesError) {
          logger.debug(`Local node_modules import failed: ${localNodeModulesError.message}`);

          // Try to find package.json and load main file
          try {
            const localPackageJsonPath = path.join(
              process.cwd(),
              'node_modules',
              repository,
              'package.json'
            );
            if (fs.existsSync(localPackageJsonPath)) {
              const packageJson = JSON.parse(fs.readFileSync(localPackageJsonPath, 'utf-8'));
              const entryPoint = packageJson.module || packageJson.main || 'dist/index.js';
              const fullEntryPath = path.join(
                process.cwd(),
                'node_modules',
                repository,
                entryPoint
              );

              await import(fullEntryPath);
              logger.info(`Successfully loaded plugin via package.json entry point: ${repository}`);
              return true;
            }
          } catch (packageJsonError) {
            logger.debug(`Package.json import failed: ${packageJsonError.message}`);
          }
        }
      }
    }

    // If we got here, all import attempts failed
    logger.warn(`Plugin installed ${context} but cannot be imported: ${directImportError.message}`);
    return false;
  } catch (error) {
    logger.warn(`Plugin installed ${context} but cannot be imported: ${error.message}`);
    return false;
  }
}

/**
 * Attempts to install a plugin in a specific directory
 * @param {string} repository - The plugin repository to install
 * @param {string} repoUrl - Cleaned repository URL
 * @param {string} versionString - Version string for installation
 * @param {boolean} useGlobalFlag - Whether to use the global flag
 * @param {string} directory - Directory to install in
 * @param {string} context - Description of the installation context for logging
 * @returns {boolean} - Whether the installation and import verification was successful
 */
async function attemptInstallation(
  repository: string,
  repoUrl: string,
  versionString: string,
  useGlobalFlag: boolean,
  directory: string,
  context: string
): Promise<boolean> {
  logger.info(`Attempting to install plugin ${context}...`);

  try {
    // Use centralized installation function
    await executeInstallation(repoUrl, versionString, useGlobalFlag, directory);

    // Verify the installation worked
    return await verifyPluginImport(repository, context);
  } catch (installError) {
    logger.warn(`Failed to install plugin ${context}: ${installError.message}`);
    return false;
  }
}

/**
 * Asynchronously installs a plugin to a specified directory.
 *
 * @param {string} repository - The repository URL of the plugin to install.
 * @param {string} cwd - The current working directory where the plugin will be installed.
 * @param {string} version - The specific version of the plugin to install.
 * @returns {Promise<boolean>} - A Promise that resolves to true if the plugin is successfully installed, or false otherwise.
 */
export async function installPlugin(
  repository: string,
  cwd: string,
  version?: string
): Promise<boolean> {
  // Mark this plugin as installed to ensure we don't get into an infinite loop
  logger.info(`Installing plugin: ${repository}`);

  // Clean repository URL
  let repoUrl = repository;
  if (repoUrl.startsWith('git+')) {
    repoUrl = repoUrl.substring(4);
  }
  if (repoUrl.endsWith('.git')) {
    repoUrl = repoUrl.slice(0, -4);
  }

  // Get installation context info
  const isGlobal = isGlobalInstallation();
  const cliDir = isGlobal ? getCliDirectory() : null;

  // Get the version string for installation
  let versionString = '';

  // If we have a version to look up in the registry
  if (version) {
    if (version.startsWith('v')) {
      versionString = `@${version}`;
    } else {
      try {
        const resolvedVersion = await getPluginVersion(repoUrl, version);
        if (resolvedVersion) {
          versionString = `#${resolvedVersion}`;
        } else {
          versionString = `@${version}`;
        }
      } catch (error) {
        // Continue with the direct version if registry lookup fails
        versionString = `@${version}`;
      }
    }
  }

  // Attempt local installation first (preferred approach)
  if (await attemptInstallation(repository, repoUrl, versionString, false, cwd, 'locally')) {
    return true;
  }

  // If local installation failed and we're running globally, try CLI directory installation
  if (
    isGlobal &&
    cliDir &&
    (await attemptInstallation(
      repository,
      repoUrl,
      versionString,
      false,
      cliDir,
      'in CLI directory'
    ))
  ) {
    return true;
  }

  // Last resort: try global installation
  if (
    isGlobal &&
    (await attemptInstallation(repository, repoUrl, versionString, true, cwd, 'globally'))
  ) {
    return true;
  }

  // If we got here, all installation attempts failed
  logger.error(`All installation attempts failed for plugin ${repository}`);
  return false;
}
