import { buildProject, displayBanner, executeInstallation, getPackageManager, handleError, isGlobalInstallation, isRunningViaBunx, isRunningViaNpx } from '@/src/utils';
import { logger } from '@elizaos/core';
import { Command } from 'commander';
import { execa } from 'execa';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import prompts from 'prompts';
import * as semver from 'semver';
import {
  detectDirectoryType,
  getDirectoryTypeDescription,
  isValidForUpdates,
  type DirectoryInfo,
} from '../utils/directory-detection';
import { UserEnvironment } from '../utils/user-environment';

// Constants
const SPECIAL_VERSION_TAGS = ['latest', 'next', 'canary', 'rc', 'dev', 'nightly', 'alpha'];
const ELIZAOS_ORG = '@elizaos';
const FALLBACK_VERSION = '0.0.0';

// Get current CLI version using UserEnvironment
async function getVersion(): Promise<string> {
  try {
    const envInfo = await UserEnvironment.getInstance().getInfo();
    return envInfo.cli.version;
  } catch (error) {
    logger.error('Error getting CLI version:', error);
    return FALLBACK_VERSION;
  }
}

// Check if version string is a workspace reference
const isWorkspaceVersion = (version: string): boolean =>
  version === 'workspace:*' || version === 'workspace' || version.startsWith('workspace:');

// Check if version is a special tag
const isSpecialVersionTag = (version: string): boolean => SPECIAL_VERSION_TAGS.includes(version);

// Version comparison helper
function checkVersionNeedsUpdate(
  currentVersion: string,
  targetVersion: string
): { needsUpdate: boolean; error?: string } {
  try {
    const cleanCurrent = String(currentVersion).replace(/^[\^~]/, '');

    if (isSpecialVersionTag(cleanCurrent)) {
      return { needsUpdate: true };
    }

    if (!semver.valid(cleanCurrent) && !semver.validRange(cleanCurrent)) {
      return { needsUpdate: false, error: 'Invalid semver format' };
    }

    const versionToCompare = semver.validRange(cleanCurrent)
      ? semver.minVersion(cleanCurrent)?.version || cleanCurrent
      : cleanCurrent;

    return { needsUpdate: semver.lt(versionToCompare, targetVersion) };
  } catch (error) {
    return { needsUpdate: false, error: error.message };
  }
}

// Check for major version update
function isMajorUpdate(currentVersion: string, targetVersion: string): boolean {
  try {
    const cleanCurrent = String(currentVersion).replace(/^[\^~]/, '');

    if (isSpecialVersionTag(cleanCurrent) || !semver.valid(cleanCurrent)) {
      return false;
    }

    const currentMajor = semver.major(cleanCurrent);
    const targetMajor = semver.major(targetVersion);
    return targetMajor > currentMajor;
  } catch {
    return false;
  }
}

// Fetch latest package version from npm registry
export async function fetchLatestVersion(packageName: string): Promise<string | null> {
  try {
    // Always check npm registry for the actual latest version
    const { stdout } = await execa('npm', ['view', packageName, 'version'], {
      env: { NODE_ENV: 'production' },
    });
    const version = stdout.trim();
    logger.debug(`Latest version of ${packageName} from npm: ${version}`);
    return version;
  } catch (error) {
    logger.error(`Failed to fetch version for ${packageName}: ${error.message}`);
    return null;
  }
}

// Check for available updates
export async function checkForUpdates(
  dependencies: Record<string, string>
): Promise<{ hasUpdates: boolean; updates: Record<string, { current: string; latest: string }> }> {
  const updates: Record<string, { current: string; latest: string }> = {};
  const elizaPackages = Object.entries(dependencies)
    .filter(([pkg]) => pkg.startsWith(ELIZAOS_ORG))
    .filter(([, version]) => !isWorkspaceVersion(version));

  for (const [pkg, currentVersion] of elizaPackages) {
    const latestVersion = await fetchLatestVersion(pkg);
    if (!latestVersion) continue;

    const { needsUpdate, error } = checkVersionNeedsUpdate(currentVersion, latestVersion);
    if (needsUpdate) {
      updates[pkg] = { current: currentVersion, latest: latestVersion };
    } else if (error) {
      logger.debug(`${pkg}: ${error}`);
    }
  }

  return { hasUpdates: Object.keys(updates).length > 0, updates };
}

// Display update summary
function displayUpdateSummary(updates: Record<string, { current: string; latest: string }>) {
  console.log('\nAvailable updates:');
  Object.entries(updates).forEach(([pkg, { current, latest }]) => {
    const majorUpdate = isMajorUpdate(current, latest);
    const updateType = majorUpdate ? ' (MAJOR)' : '';
    console.log(`  ${pkg}: ${current} → ${latest}${updateType}`);
  });
}

// Update package.json with new versions
async function updatePackageJson(
  packageJsonPath: string,
  updates: Record<string, { current: string; latest: string }>
) {
  const content = await fs.readFile(packageJsonPath, 'utf8');
  const packageJson = JSON.parse(content);

  let modified = false;
  for (const [pkg, { latest }] of Object.entries(updates)) {
    if (packageJson.dependencies?.[pkg]) {
      packageJson.dependencies[pkg] = `^${latest}`;
      modified = true;
    }
    if (packageJson.devDependencies?.[pkg]) {
      packageJson.devDependencies[pkg] = `^${latest}`;
      modified = true;
    }
  }

  if (modified) {
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
    console.log('Updated package.json with new versions');
  }
}

// Main dependency update function
async function updateDependencies(
  cwd: string,
  isPlugin: boolean,
  dryRun: boolean = false,
  skipBuild: boolean = false
): Promise<void> {
  const packageJsonPath = path.join(cwd, 'package.json');
  const content = await fs.readFile(packageJsonPath, 'utf8');
  const packageJson = JSON.parse(content);

  const allDependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  // Check for updates
  const { hasUpdates, updates } = await checkForUpdates(allDependencies);

  if (!hasUpdates) {
    console.log('All ElizaOS packages are up to date! [✓]');
    return;
  }

  displayUpdateSummary(updates);

  if (dryRun) {
    console.log('\nTo apply these updates, run: elizaos update');
    return;
  }

  // Check for major updates
  const hasMajorUpdates = Object.entries(updates).some(([, { current, latest }]) =>
    isMajorUpdate(current, latest)
  );

  if (hasMajorUpdates) {
    const { confirmMajor } = await prompts({
      type: 'confirm',
      name: 'confirmMajor',
      message: 'This update includes major version changes. Continue?',
      initial: false,
    });

    if (!confirmMajor) {
      console.log('Update cancelled');
      return;
    }
  }

  // Update package.json
  await updatePackageJson(packageJsonPath, updates);

  // Install dependencies
  console.log('\nInstalling updated packages...');
  try {
    const packageManager = await getPackageManager();
    await execa(packageManager, ['install'], { cwd, stdio: 'inherit' });
    console.log('Dependencies installed successfully [✓]');
  } catch (error) {
    throw new Error(`Failed to install dependencies: ${error.message}`);
  }

  // Build if not skipped
  if (!skipBuild) {
    console.log('\nBuilding project...');
    await buildProject(cwd, isPlugin);
    console.log('Build completed successfully [✓]');
  }
}

// Update CLI to latest version
export async function performCliUpdate(): Promise<boolean> {
  try {
    const currentVersion = await getVersion();
    const latestVersion = await fetchLatestVersion('@elizaos/cli');

    if (!latestVersion) {
      throw new Error('Unable to fetch latest CLI version');
    }

    const { needsUpdate } = checkVersionNeedsUpdate(currentVersion, latestVersion);
    if (!needsUpdate) {
      console.log(`CLI is already at the latest version (${currentVersion}) [✓]`);
      return true;
    }

    console.log(`Updating CLI from ${currentVersion} to ${latestVersion}...`);

    const packageToInstall = '@elizaos/cli';
    await executeInstallation(packageToInstall, latestVersion, process.cwd());
    console.log(`CLI updated successfully to version ${latestVersion} [✓]`);
    return true;
  } catch (error) {
    console.error(`CLI update failed: ${error.message}`);
    return false;
  }
}

// Handle invalid directory scenarios
function handleInvalidDirectory(directoryInfo: DirectoryInfo) {
  const messages = {
    empty: [
      'This appears to be an empty directory.',
      'To create a new ElizaOS project or plugin, use:',
      '  elizaos create <project-name>          # Create a new project',
      '  elizaos create -t plugin <plugin-name> # Create a new plugin',
    ],
    'non-elizaos-project': [
      "This directory contains a project, but it doesn't appear to be an ElizaOS project.",
      directoryInfo.packageName && `Found package: ${directoryInfo.packageName}`,
      'ElizaOS update only works in ElizaOS projects and plugins.',
      'To create a new ElizaOS project, use: elizaos create <project-name>',
    ].filter(Boolean),
    invalid: [
      'Cannot update packages in this directory.',
      !directoryInfo.hasPackageJson
        ? "No package.json found. This doesn't appear to be a valid project directory."
        : 'The package.json file appears to be invalid or unreadable.',
      'To create a new ElizaOS project, use: elizaos create <project-name>',
    ].filter(Boolean),
  };

  const messageList = messages[directoryInfo.type];
  if (messageList) {
    messageList.forEach((msg) => console.info(msg));
  } else {
    console.error(`Unexpected directory type: ${directoryInfo.type}`);
  }
}

// Main update command
export const update = new Command()
  .name('update')
  .description('Update ElizaOS CLI and project dependencies')
  .option('-c, --check', 'Check for available updates without applying them')
  .option('-sb, --skip-build', 'Skip building after updating')
  .option('--cli', 'Update only the CLI')
  .option('--packages', 'Update only packages')
  .hook('preAction', async () => {
    try {
      await displayBanner();
    } catch {
      logger.debug('Banner display failed, continuing with update');
    }
  })
  .action(async (options) => {
    try {
      // Determine what to update
      const updateCli = options.cli || (!options.cli && !options.packages);
      const updatePackages = options.packages || (!options.cli && !options.packages);

      // Handle CLI update
      if (updateCli) {
        const isNpx = await isRunningViaNpx();
        const isBunx = await isRunningViaBunx();

        if (isNpx || isBunx) {
          console.warn('CLI update is not available when running via npx or bunx.');
          console.info('Please install the CLI globally:');
          console.info('  npm install -g @elizaos/cli');
          console.info('  # or');
          console.info('  bun add -g @elizaos/cli');

          if (!updatePackages) return;
        } else {
          const success = await performCliUpdate();
          if (!updatePackages) return;
          if (!success) {
            console.warn('CLI update failed, continuing with package updates...');
          }
        }
      }

      // Handle package updates
      if (updatePackages) {
        const cwd = process.cwd();
        const directoryInfo = detectDirectoryType(cwd);

        logger.debug(`Detected ${getDirectoryTypeDescription(directoryInfo)}`);

        if (!isValidForUpdates(directoryInfo)) {
          handleInvalidDirectory(directoryInfo);
          return;
        }

        const isPlugin = directoryInfo.type === 'elizaos-plugin';

        if (directoryInfo.elizaPackageCount === 0) {
          console.info('No ElizaOS packages found in this project.');
          console.info("This might be a new project that hasn't installed ElizaOS dependencies yet.");
          console.info('Consider adding ElizaOS packages first, such as: bun add @elizaos/core');
          return;
        }

        console.info(`Found ${directoryInfo.elizaPackageCount} ElizaOS package(s) to check for updates`);

        await updateDependencies(cwd, isPlugin, options.check, options.skipBuild);

        if (options.check) {
          console.log(`Version: ${await getVersion()}`);
        } else {
          const projectType = isPlugin ? 'Plugin' : 'Project';
          console.log(`${projectType} successfully updated to the latest ElizaOS packages`);
        }
      }
    } catch (error) {
      handleError(error);
    }
  });
