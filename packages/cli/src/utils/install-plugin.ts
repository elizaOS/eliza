import fs from 'node:fs';
import path from 'node:path';
import { logger } from '@elizaos/core';
import { loadPluginModule } from './load-plugin';
import { fetchPluginRegistry } from './plugin-discovery';
import { runBunCommand } from './run-bun';

/**
 * Get the CLI's installation directory when running globally
 * @returns {string|null} - The path to the CLI's directory or null if not found
 */
/* function getCliDirectory(): string | null {
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
} */

/**
 * Check if a plugin exists in the workspace
 * @param {string} packageName - The plugin package name
 * @returns {boolean} - Whether the plugin exists in the workspace
 */
/* function isWorkspacePlugin(packageName: string): boolean {
  // Check if it's an @elizaos scoped package
  if (packageName.startsWith('@elizaos/')) {
    // Try to find the plugin in the workspace
    const pluginName = packageName.replace('@elizaos/', '');
    const workspacePaths = [
      path.resolve(process.cwd(), '..', pluginName),
      path.resolve(process.cwd(), '..', '..', 'packages', pluginName),
    ];

    for (const workspacePath of workspacePaths) {
      if (fs.existsSync(path.join(workspacePath, 'package.json'))) {
        logger.debug(`Found workspace plugin at: ${workspacePath}`);
        return true;
      }
    }
  }
  return false;
} */

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
/* async function attemptInstallation(
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
 * Creates a temporary package.json with workspace overrides for local packages
 */
/* async function createTempPackageJsonWithOverrides(
  cwd: string,
  packageName: string
): Promise<string | null> {
  try {
    const rootPackageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
    );

    // Get all workspace packages
    const workspacePackages = new Map<string, string>();
    const workspaces = rootPackageJson.workspaces || [];

    for (const workspace of workspaces) {
      const workspacePattern = workspace.replace('/*', '');
      const packagesDir = path.join(process.cwd(), workspacePattern);

      if (fs.existsSync(packagesDir)) {
        const packages = fs.readdirSync(packagesDir).filter((dir) => {
          const pkgPath = path.join(packagesDir, dir, 'package.json');
          return fs.existsSync(pkgPath);
        });

        for (const pkg of packages) {
          const pkgJsonPath = path.join(packagesDir, pkg, 'package.json');
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
          if (pkgJson.name) {
            workspacePackages.set(pkgJson.name, `workspace:*`);
          }
        }
      }
    }

    // Create a temporary package.json with overrides
    const tempPkgJson = {
      name: 'temp-install',
      version: '1.0.0',
      type: 'module',
      dependencies: {
        [packageName]: 'latest',
      },
      overrides: Object.fromEntries(workspacePackages),
      resolutions: Object.fromEntries(workspacePackages),
    };

    const tempPath = path.join(cwd, '.temp-package.json');
    fs.writeFileSync(tempPath, JSON.stringify(tempPkgJson, null, 2));
    return tempPath;
  } catch (error) {
    logger.debug('Failed to create temp package.json:', error);
    return null;
  }
}

/**
 * Check if we're in a monorepo workspace
 */
function isInMonorepo(): boolean {
  try {
    // Check for root package.json with workspaces
    const rootPkgPath = path.join(process.cwd(), 'package.json');
    if (fs.existsSync(rootPkgPath)) {
      const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
      return !!rootPkg.workspaces;
    }

    // Check if we're in a subdirectory of a monorepo
    let currentDir = process.cwd();
    while (currentDir !== path.dirname(currentDir)) {
      const pkgPath = path.join(currentDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.workspaces) {
          return true;
        }
      }
      currentDir = path.dirname(currentDir);
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Find the monorepo root directory
 */
function findMonorepoRoot(): string | null {
  try {
    let currentDir = process.cwd();
    while (currentDir !== path.dirname(currentDir)) {
      const pkgPath = path.join(currentDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.workspaces) {
          return currentDir;
        }
      }
      currentDir = path.dirname(currentDir);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get all workspace packages in the monorepo
 */
async function getWorkspacePackages(): Promise<Map<string, string>> {
  const workspacePackages = new Map<string, string>();
  const monorepoRoot = findMonorepoRoot();

  if (!monorepoRoot) {
    return workspacePackages;
  }

  try {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(monorepoRoot, 'package.json'), 'utf8'));

    const workspaces = rootPkg.workspaces || [];

    for (const workspace of workspaces) {
      const workspacePattern = workspace.replace('/*', '');
      const packagesDir = path.join(monorepoRoot, workspacePattern);

      if (fs.existsSync(packagesDir)) {
        const packages = fs.readdirSync(packagesDir).filter((dir) => {
          const pkgPath = path.join(packagesDir, dir, 'package.json');
          return fs.existsSync(pkgPath);
        });

        for (const pkg of packages) {
          const pkgJsonPath = path.join(packagesDir, pkg, 'package.json');
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
          if (pkgJson.name) {
            // Store the absolute path to the package
            workspacePackages.set(pkgJson.name, path.join(packagesDir, pkg));
          }
        }
      }
    }
  } catch (error) {
    logger.debug('Failed to get workspace packages:', error);
  }

  return workspacePackages;
}

/**
 * Asynchronously installs a plugin to a specified directory.
 *
 * Cascading order:
 * 1. Check if already in local node_modules (workspace)
 * 2. Check if it's a workspace package in the monorepo
 * 3. Check plugin registry
 * 4. Check if available in global node_modules (handled by load flow)
 * 5. Try NPM installation (with workspace dependency handling)
 * 6. Fallback to GitHub at /elizaos-plugins/plugin-<name>
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
  versionSpecifier: string = 'latest',
  skipVerification: boolean = false
): Promise<boolean> {
  // Check if we're already installing this plugin
  if (process.env.ELIZA_INSTALLING_PLUGIN === packageName) {
    logger.warn(`Detected recursive installation attempt for ${packageName}, skipping`);
    return false;
  }

  // Set environment variable to prevent recursion
  process.env.ELIZA_INSTALLING_PLUGIN = packageName;

  try {
    logger.info(`Looking for plugin ${packageName}...`);

    // 1. Check if it's already in local node_modules
    const localPath = path.join(cwd, 'node_modules', packageName);
    if (fs.existsSync(localPath)) {
      logger.info(`Plugin ${packageName} already installed locally`);
      return true;
    }

    // 2. FIRST check if it's a workspace package in the monorepo
    if (isInMonorepo()) {
      const workspacePackages = await getWorkspacePackages();
      if (workspacePackages.has(packageName)) {
        logger.info(`Plugin ${packageName} is available as a workspace package`);

        // Create a symlink to the workspace package
        const packagePath = workspacePackages.get(packageName)!;
        const targetPath = path.join(cwd, 'node_modules', packageName);

        // Ensure node_modules directory exists
        const nodeModulesPath = path.join(cwd, 'node_modules');
        if (!fs.existsSync(nodeModulesPath)) {
          fs.mkdirSync(nodeModulesPath, { recursive: true });
        }

        // Create parent directories if needed (for scoped packages like @elizaos/...)
        const parentDir = path.dirname(targetPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        // Create symlink
        try {
          // Remove existing symlink if it exists
          if (fs.existsSync(targetPath)) {
            fs.unlinkSync(targetPath);
          }
          fs.symlinkSync(packagePath, targetPath, 'dir');
          logger.success(`Created symlink to workspace package ${packageName}`);
          return true;
        } catch (error) {
          logger.debug(`Failed to create symlink: ${error}`);
          // Continue to other installation methods
        }
      }
    }

    // If not found in workspace, try external sources
    logger.info(`Plugin ${packageName} not found in workspace, checking external sources...`);

    // 3. Check plugin registry
    try {
      const registry = await fetchPluginRegistry();
      if (registry && registry.registry[packageName]) {
        logger.info(`Found ${packageName} in plugin registry`);
        // TODO: Implement registry installation
        // For now, fall through to NPM installation
      }
    } catch (error) {
      logger.debug(`Plugin ${packageName} not found in registry:`, error);
    }

    // 4. NPM installation (with workspace dependency handling)
    const npmPackageName =
      versionSpecifier !== 'latest' ? `${packageName}@${versionSpecifier}` : packageName;

    try {
      logger.info(`Attempting NPM install for ${npmPackageName}...`);

      // If we're in a monorepo, we need to ensure workspace packages are resolved
      if (isInMonorepo()) {
        const monorepoRoot = findMonorepoRoot();
        if (monorepoRoot) {
          // Get all workspace packages for resolution
          const workspacePackages = await getWorkspacePackages();

          // Create a temporary package.json with resolutions
          const tempPkgPath = path.join(cwd, 'temp-install-package.json');
          const resolutions: Record<string, string> = {};

          // Add all workspace packages as resolutions
          for (const [pkgName, pkgPath] of workspacePackages) {
            resolutions[pkgName] = `file:${pkgPath}`;
          }

          const tempPkg = {
            name: 'temp-install',
            version: '1.0.0',
            type: 'module',
            dependencies: {
              [packageName]: versionSpecifier !== 'latest' ? versionSpecifier : '*',
            },
            resolutions,
            overrides: resolutions,
          };

          fs.writeFileSync(tempPkgPath, JSON.stringify(tempPkg, null, 2));

          try {
            // Install using the temporary package.json
            logger.debug(`Installing with workspace resolutions...`);
            await runBunCommand(['install'], cwd);

            // Clean up
            fs.unlinkSync(tempPkgPath);

            // Move the installed package from temp-install node_modules to the actual location
            const tempNodeModules = path.join(cwd, 'node_modules');
            if (fs.existsSync(path.join(tempNodeModules, packageName))) {
              if (!skipVerification) {
                await verifyPluginImport(packageName, 'from NPM with workspace resolution');
              }
              logger.success(
                `Successfully installed ${packageName} from NPM with workspace dependencies`
              );
              return true;
            }
          } catch (error) {
            // Clean up on error
            if (fs.existsSync(tempPkgPath)) {
              fs.unlinkSync(tempPkgPath);
            }
            logger.debug(`Workspace-aware installation failed: ${error}`);
            // Fall through to standard installation
          }
        }
      }

      // Standard installation (without workspace resolution)
      await runBunCommand(['add', npmPackageName], cwd);

      if (!skipVerification) {
        await verifyPluginImport(packageName, 'from NPM');
      }

      logger.success(`Successfully installed ${packageName} from NPM`);
      return true;
    } catch (npmError: any) {
      logger.warn(`Installation failed for ${npmPackageName}: ${npmError.message}`);
    }

    // 5. GitHub fallback for elizaos plugins
    if (packageName.startsWith('@elizaos/plugin-')) {
      const pluginName = packageName.replace('@elizaos/plugin-', '');
      const githubUrl =
        versionSpecifier !== 'latest'
          ? `github:elizaos-plugins/plugin-${pluginName}#${versionSpecifier}`
          : `github:elizaos-plugins/plugin-${pluginName}`;

      try {
        logger.info(`Attempting GitHub install from ${githubUrl}...`);

        // If in monorepo, use workspace resolutions for GitHub installs too
        if (isInMonorepo()) {
          const workspacePackages = await getWorkspacePackages();
          const args = ['add', githubUrl];

          // Add resolutions for workspace packages
          for (const [pkgName, pkgPath] of workspacePackages) {
            args.push('--resolution', `${pkgName}@file:${pkgPath}`);
          }

          await runBunCommand(args, cwd);
        } else {
          await runBunCommand(['add', githubUrl], cwd);
        }

        if (!skipVerification) {
          await verifyPluginImport(packageName, 'from GitHub');
        }

        logger.success(`Successfully installed ${packageName} from GitHub`);
        return true;
      } catch (githubError: any) {
        logger.warn(`GitHub installation failed for ${packageName}: ${githubError.message}`);
      }
    }

    logger.error(`Failed to install plugin ${packageName} from any source`);
    return false;
  } finally {
    // Clean up environment variable
    delete process.env.ELIZA_INSTALLING_PLUGIN;
  }
}
