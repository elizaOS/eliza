import { logger } from '@elizaos/core';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadPluginModule } from './load-plugin';
import { executeInstallation, executeInstallationWithFallback } from './package-manager';
import { fetchPluginRegistry } from './plugin-discovery';
import { normalizePluginName } from './registry';
import { detectPluginContext } from './plugin-context';

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
      if (existsSync(path.join(cliDir, 'package.json'))) {
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
    logger.debug(`Successfully verified plugin ${repository} ${context} after installation.`);
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
 * @param {boolean} skipVerification - Whether to skip import verification
 * @returns {boolean} - Whether the installation and import verification was successful
 */
async function attemptInstallation(
  packageName: string,
  versionString: string,
  directory: string,
  context: string,
  skipVerification = false
): Promise<boolean> {
  logger.debug(`Attempting to install plugin ${context}...`);

  try {
    // Use centralized installation function which now returns success status and identifier
    const installResult = await executeInstallation(packageName, versionString, directory);

    // If installation failed, return false immediately
    if (!installResult.success || !installResult.installedIdentifier) {
      logger.warn(`Installation failed for plugin ${context}`);
      return false;
    }

    // If installed via direct GitHub specifier, skip import verification
    if (packageName.startsWith('github:')) {
      return true;
    }
    if (skipVerification || process.env.ELIZA_SKIP_PLUGIN_VERIFY) {
      logger.info(
        `Installation successful for ${installResult.installedIdentifier}, skipping verification`
      );
      return true;
    }
    logger.debug(
      `Installation successful for ${installResult.installedIdentifier}, verifying import...`
    );
    return await verifyPluginImport(installResult.installedIdentifier, context);
  } catch (installError) {
    // Catch any unexpected errors during the process
    logger.warn(
      `Error during installation attempt ${context}: ${installError instanceof Error ? installError.message : String(installError)}`
    );
    return false;
  }
}

/**
 * Asynchronously installs a plugin to a specified directory.
 *
 * @param {string} packageName - The repository URL of the plugin to install.
 * @param {string} cwd - The current working directory where the plugin will be installed.
 * @param {string} versionSpecifier - The specific version of the plugin to install.
 * @param {boolean} skipVerification - Whether to skip import verification.
 * @returns {Promise<boolean>} - A Promise that resolves to true if the plugin is successfully installed, or false otherwise.
 */
export async function installPlugin(
  packageName: string,
  cwd: string,
  versionSpecifier?: string,
  skipVerification = false
): Promise<boolean> {
  logger.debug(`Installing plugin: ${packageName}`);

  // Check if we're trying to install a plugin into its own directory
  const context = detectPluginContext(packageName);
  if (context.isLocalDevelopment) {
    logger.warn(`Prevented self-installation of plugin ${packageName}`);
    logger.info(
      `You're developing this plugin locally. Use 'bun run build' to build it instead of installing.`
    );
    return false;
  }

  const cliDir = getCliDirectory();

  // Direct GitHub installation
  if (packageName.startsWith('github:')) {
    return await attemptInstallation(packageName, '', cwd, '', skipVerification);
  }

  // Handle full GitHub URLs as well
  const httpsGitHubUrlRegex =
    /^https?:\/\/github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?(?:#([a-zA-Z0-9_.-]+))?\/?$/;
  const httpsMatch = packageName.match(httpsGitHubUrlRegex);
  if (httpsMatch) {
    const [, owner, repo, ref] = httpsMatch;
    const spec = `github:${owner}/${repo}${ref ? `#${ref}` : ''}`;
    return await attemptInstallation(spec, '', cwd, '', skipVerification);
  }

  const cache = await fetchPluginRegistry();
  const possible = normalizePluginName(packageName);

  let key: string | null = null;
  for (const name of possible) {
    if (cache?.registry[name]) {
      key = name;
      break;
    }
  }

  if (!key && cache && cache.registry) {
    // Fuzzy search by stripped base name
    let base = packageName;
    if (base.includes('/')) {
      const parts = base.split('/');
      base = parts[parts.length - 1];
    }
    base = base.replace(/^@/, '').replace(/^(plugin|client)-/, '');
    const lower = base.toLowerCase();

    const matches = Object.keys(cache.registry).filter(
      (cand) => cand.toLowerCase().includes(lower) && !cand.includes('client-')
    );

    if (matches.length > 0) {
      const pluginMatch = matches.find((c) => c.includes('plugin-'));
      key = pluginMatch || matches[0];
    }
  }

  if (!key) {
    logger.warn(
      `Plugin ${packageName} not found in registry cache, attempting direct installation`
    );
    return await attemptInstallation(
      packageName,
      versionSpecifier || '',
      cwd,
      '',
      skipVerification
    );
  }

  const info = cache!.registry[key];

  // Extract GitHub fallback information if available
  const githubFallback = info.git?.repo;
  const githubVersion = info.git?.v1?.branch || info.git?.v1?.version || '';

  // Prefer npm installation with GitHub fallback if repository is available
  if (info.npm?.repo) {
    const ver = versionSpecifier || info.npm.v1 || '';
    const result = await executeInstallationWithFallback(info.npm.repo, ver, cwd, githubFallback);

    if (result.success) {
      // Verify import if not a GitHub install
      if (
        !info.npm.repo.startsWith('github:') &&
        !skipVerification &&
        !process.env.ELIZA_SKIP_PLUGIN_VERIFY
      ) {
        const importSuccess = await verifyPluginImport(
          result.installedIdentifier || info.npm.repo,
          'from npm with potential GitHub fallback'
        );
        return importSuccess;
      }
      return true;
    }
  } else if (info.npm?.v1) {
    const result = await executeInstallationWithFallback(key, info.npm.v1, cwd, githubFallback);

    if (result.success) {
      // Verify import if not a GitHub install
      if (!skipVerification && !process.env.ELIZA_SKIP_PLUGIN_VERIFY) {
        const importSuccess = await verifyPluginImport(
          result.installedIdentifier || key,
          'from npm registry with potential GitHub fallback'
        );
        return importSuccess;
      }
      return true;
    }
  }

  // If both npm approaches failed, try direct GitHub installation as final fallback
  if (info.git?.repo && cliDir) {
    const spec = `github:${info.git.repo}${githubVersion ? `#${githubVersion}` : ''}`;
    return await attemptInstallation(spec, '', cliDir, 'in CLI directory', skipVerification);
  }

  logger.error(`Failed to install plugin ${packageName}`);
  return false;
}
