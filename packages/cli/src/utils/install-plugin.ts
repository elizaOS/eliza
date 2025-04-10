import { logger } from '@elizaos/core';
import fs from 'node:fs';
import path from 'node:path';
import { loadPluginModule } from './load-plugin';
import { executeInstallation } from './package-manager';
import { getPluginVersion } from './registry';

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
  repository: string,
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
    // Use centralized installation function with all approaches
    await executeInstallation(repository, versionString, directory, options);

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
 * @param {string} monorepoBranch - The specific branch to use for monorepo installation.
 * @returns {Promise<boolean>} - A Promise that resolves to true if the plugin is successfully installed, or false otherwise.
 */
export async function installPlugin(
  repository: string,
  cwd: string,
  version?: string,
  monorepoBranch?: string
): Promise<boolean> {
  // Mark this plugin as installed to ensure we don't get into an infinite loop
  logger.info(`Installing plugin: ${repository}`);

  // Clean repository URL - only if it looks like a GitHub URL
  let repoUrl = repository;

  // Leave scoped packages as-is to prioritize npm registry
  if (!repository.startsWith('@')) {
    if (repoUrl.startsWith('git+')) {
      repoUrl = repoUrl.substring(4);
    }
    if (repoUrl.endsWith('.git')) {
      repoUrl = repoUrl.slice(0, -4);
    }
  }

  // Get installation context info
  const cliDir = getCliDirectory();

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

  // Try installation in the current directory with all approaches
  if (
    await attemptInstallation(repository, versionString, cwd, 'with all installation methods', {
      tryNpm: true,
      tryGithub: true,
      tryMonorepo: true,
      monorepoBranch,
    })
  ) {
    return true;
  }

  // If all local installations failed and we're running globally, try CLI directory installation
  if (cliDir) {
    if (
      await attemptInstallation(repository, versionString, cliDir, 'in CLI directory', {
        tryNpm: true,
        tryGithub: true,
        tryMonorepo: true,
        monorepoBranch,
      })
    ) {
      return true;
    }
  }

  // If we got here, all installation attempts failed
  logger.error(`All installation attempts failed for plugin ${repository}`);
  return false;
}
