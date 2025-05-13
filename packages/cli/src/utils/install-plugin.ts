import { logger } from '@elizaos/core';
import fs from 'node:fs';
import path from 'node:path';
import { loadPluginModule } from './load-plugin';
import { executeInstallation } from './package-manager';

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
  // Use the new centralized loader function
  const loadedModule = await loadPluginModule(repository);

  if (loadedModule) {
    logger.info(`Successfully verified plugin ${repository} ${context} after installation.`);
    return true;
  } else {
    // The loadPluginModule function already logs detailed errors
    logger.warn(`Plugin ${repository} installed ${context} but could not be loaded/verified.`);
    return false;
  }
}

/**
 * Attempts to install a plugin in a specific directory
 * @param {string} repository - The plugin repository to install
 * @param {string} versionString - Version string for installation
 * @param {string} directory - Directory to install in
 * @param {string} context - Description of the installation context for logging
 * @returns {boolean} - Whether the installation and import verification was successful
 */
async function attemptInstallation(
  packageName: string,
  versionString: string,
  directory: string,
  context: string,
  options: {
    tryNpm?: boolean;
    tryGithub?: boolean;
    tryMonorepo?: boolean;
    monorepoBranch?: string;
  } = {}
): Promise<boolean> {
  logger.info(`Attempting to install plugin ${context}...`);

  try {
    // For third-party plugins (fully qualified npm packages), preserve the original name
    const isThirdParty = packageName.startsWith('@') && packageName.includes('/');
    const targetPackageName = isThirdParty ? packageName : packageName;

    // Use centralized installation function which now returns success status and identifier
    const installResult = await executeInstallation(
      targetPackageName,
      versionString,
      directory,
      options
    );

    // If installation failed, return false immediately
    if (!installResult.success || !installResult.installedIdentifier) {
      logger.warn(`Installation failed for plugin ${context}`);
      return false;
    }

    // Installation succeeded, now verify the import using the correct identifier
    const identifier = isThirdParty ? targetPackageName : installResult.installedIdentifier;
    logger.info(`Installation successful for ${identifier}, verifying import...`);
    return await verifyPluginImport(identifier, context);
  } catch (installError) {
    // Catch any unexpected errors during the process
    logger.warn(`Error during installation attempt ${context}: ${installError.message}`);
    return false;
  }
}

/**
 * Asynchronously installs a plugin to a specified directory.
 *
 * @param {string} packageName - The repository URL of the plugin to install.
 * @param {string} cwd - The current working directory where the plugin will be installed.
 * @param {string} versionSpecifier - The specific version of the plugin to install.
 * @param {string} monorepoBranch - The specific branch to use for monorepo installation.
 * @returns {Promise<boolean>} - A Promise that resolves to true if the plugin is successfully installed, or false otherwise.
 */
export async function installPlugin(
  packageName: string,
  cwd: string,
  versionSpecifier?: string,
  monorepoBranch?: string
): Promise<boolean> {
  // Mark this plugin as installed to ensure we don't get into an infinite loop
  logger.info(`Installing plugin: ${packageName}`);

  // Get installation context info
  const cliDir = getCliDirectory();

  // Simplified installation options
  const installOptions = {
    tryNpm: true,
    // Only try GitHub for non-scoped packages without version
    tryGithub: !packageName.startsWith('@') && !versionSpecifier,
    // Only try monorepo for non-versioned packages
    tryMonorepo: !versionSpecifier,
    monorepoBranch,
  };

  // Try installation in the current directory with determined approaches
  if (await attemptInstallation(packageName, versionSpecifier || '', cwd, ':', installOptions)) {
    return true;
  }

  // If all local installations failed and we're running globally, try CLI directory installation
  if (cliDir) {
    if (
      await attemptInstallation(
        packageName,
        versionSpecifier || '',
        cliDir,
        'in CLI directory',
        installOptions
      )
    ) {
      return true;
    }
  }

  // If we got here, all installation attempts failed
  logger.error(`All installation attempts failed for plugin ${packageName}`);
  return false;
}
