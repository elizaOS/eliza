import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildProject } from '@/src/utils/build-project';
import { handleError } from '@/src/utils/handle-error';
import { runBunCommand } from '@/src/utils/run-bun';
import { logger } from '@elizaos/core';
import { Command } from 'commander';
import prompts from 'prompts';
import semver from 'semver';

// define __dirname
const __dirname = new URL('.', import.meta.url).pathname;
/**
 * Get the current CLI version from package.json
 * @returns The current CLI version
 */
function getCurrentCliVersion(): string {
  try {
    // Read the package.json file directly
    const packageJsonPath = path.resolve(__dirname, '../package.json');
    const packageJsonContent = readFileSync(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageJsonContent);
    return packageJson.version || '0.0.0';
  } catch (error) {
    // Fallback for when running from source
    try {
      const packageJsonPath = path.resolve(__dirname, '../../package.json');
      if (existsSync(packageJsonPath)) {
        const packageJsonContent = readFileSync(packageJsonPath, 'utf8');
        const packageJson = JSON.parse(packageJsonContent);
        return packageJson.version || '0.0.0';
      }
    } catch (nestedError) {
      // Ignore nested error
    }

    logger.warn(`Could not determine CLI version: ${error.message}`);
    return '0.0.0';
  }
}

/**
 * Check if a package is using a workspace reference
 * @param versionString The version string to check
 * @returns Whether the version string indicates a workspace reference
 */
function isWorkspaceVersion(versionString: string): boolean {
  return (
    versionString === 'workspace:*' ||
    versionString === 'workspace' ||
    versionString.startsWith('workspace:')
  );
}

/**
 * Updates dependencies in a project or plugin to the latest ElizaOS versions
 * @param cwd Working directory of the project/plugin
 * @param isPlugin Whether this is a plugin or project
 */
async function updateDependencies(cwd: string, isPlugin: boolean): Promise<void> {
  logger.info(`Updating ${isPlugin ? 'plugin' : 'project'} dependencies...`);

  const cliVersion = getCurrentCliVersion();
  logger.info(`Current CLI version: ${cliVersion}`);

  try {
    // Get list of installed dependencies
    const packageJsonPath = path.join(cwd, 'package.json');
    if (!existsSync(packageJsonPath)) {
      logger.error('package.json not found in the current directory');
      return;
    }

    const packageJsonContent = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageJsonContent);
    const dependencies = packageJson.dependencies || {};
    const devDependencies = packageJson.devDependencies || {};

    // Find all ElizaOS packages
    const elizaPackages = [...Object.entries(dependencies), ...Object.entries(devDependencies)]
      .filter(([pkg]) => pkg.startsWith('@elizaos/'))
      .map(([pkg, version]) => ({ name: pkg, version }));

    if (elizaPackages.length === 0) {
      logger.info('No ElizaOS packages found to update');
      return;
    }

    // Check for workspace references
    const workspacePackages = elizaPackages.filter((pkg) =>
      isWorkspaceVersion(pkg.version as string)
    );
    if (workspacePackages.length > 0) {
      logger.info(
        `Found ${workspacePackages.length} workspace references: ${workspacePackages.map((p) => p.name).join(', ')}`
      );
      logger.info(
        'Skipping update for workspace packages as they should be managed by the monorepo'
      );

      // Remove workspace packages from the update list
      const packagesToUpdate = elizaPackages.filter(
        (pkg) => !isWorkspaceVersion(pkg.version as string)
      );
      if (packagesToUpdate.length === 0) {
        logger.info('No non-workspace ElizaOS packages to update');
        return;
      }

      logger.info(
        `Will update ${packagesToUpdate.length} non-workspace packages: ${packagesToUpdate.map((p) => p.name).join(', ')}`
      );

      // Update the list to only include non-workspace packages
      elizaPackages.length = 0;
      elizaPackages.push(...packagesToUpdate);
    } else {
      logger.info(
        `Found ${elizaPackages.length} ElizaOS packages: ${elizaPackages.map((p) => p.name).join(', ')}`
      );
    }

    // Determine update type - minor by default, major requires confirmation
    const hasMajorUpdates = elizaPackages.some((pkg) => {
      const pkgVersion = String(pkg.version).replace(/^\^|~/, '');
      return pkgVersion && cliVersion && semver.major(cliVersion) > semver.major(pkgVersion);
    });

    if (hasMajorUpdates) {
      const { confirmMajor } = await prompts({
        type: 'confirm',
        name: 'confirmMajor',
        message: 'Major version updates detected. This may include breaking changes. Continue?',
        initial: false,
      });

      if (!confirmMajor) {
        logger.info('Update canceled');
        return;
      }
    }

    // Update each package to the specific CLI version instead of latest
    for (const pkg of elizaPackages) {
      try {
        logger.info(`Updating ${pkg.name} to version ${cliVersion}...`);
        await runBunCommand(['add', `${pkg.name}@${cliVersion}`], cwd);
      } catch (error) {
        logger.error(`Failed to update ${pkg.name}: ${error.message}`);
        logger.info('Trying to use exact version match...');
        try {
          // If the specific version isn't available, try to find the closest version
          await runBunCommand(['add', pkg.name], cwd);
        } catch (secondError) {
          logger.error(`Failed to install ${pkg.name} after retrying: ${secondError.message}`);
        }
      }
    }

    logger.success('Dependencies updated successfully');

    // Run install to ensure all dependencies are properly installed
    logger.info('Installing updated dependencies...');
    await runBunCommand(['install'], cwd);

    // Build the project/plugin with updated dependencies
    await buildProject(cwd, isPlugin);
  } catch (error) {
    logger.error(`Error updating dependencies: ${error.message}`);
  }
}

/**
 * Check if the current directory is likely a plugin directory
 */
function checkIfPluginDir(dir: string): boolean {
  const packageJsonPath = path.join(dir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const packageJsonContent = readFileSync(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageJsonContent);
    if (packageJson.name?.startsWith('@elizaos/plugin-')) {
      return true;
    }

    const keywords = packageJson.keywords || [];
    return keywords.includes('elizaos-plugin');
  } catch {
    return false;
  }
}

// Create command for updating dependencies
export const update = new Command()
  .name('update')
  .description('Update ElizaOS packages to the latest versions')
  .option('--check', 'Check for available updates without applying them')
  .option('--skip-build', 'Skip building after updating')
  .action(async (options) => {
    try {
      const cwd = process.cwd();

      // Determine if we're in a project or plugin directory
      const isPlugin = checkIfPluginDir(cwd);
      logger.info(`Detected ${isPlugin ? 'plugin' : 'project'} directory`);

      if (options.check) {
        // Only check for updates without applying them
        logger.info('Checking for available updates...');
        const cliVersion = getCurrentCliVersion();
        logger.info(`Current CLI version: ${cliVersion}`);
        logger.info('To apply updates, run this command without the --check flag');
        return;
      }

      // Update dependencies
      await updateDependencies(cwd, isPlugin);

      logger.success(
        `${isPlugin ? 'Plugin' : 'Project'} successfully updated to the latest ElizaOS packages`
      );
    } catch (error) {
      handleError(error);
    }
  });
