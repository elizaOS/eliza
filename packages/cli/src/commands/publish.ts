import {
  displayBanner,
  getGitHubCredentials,
  handleError,
  publishToGitHub,
  testPublishToGitHub,
  testPublishToNpm,
} from '@/src/utils';
import {
  getRegistrySettings,
  initializeDataDir,
  saveRegistrySettings,
  validateDataDir,
} from '@/src/utils/registry/index';
import { detectDirectoryType, getDirectoryTypeDescription } from '@/src/utils/directory-detection';
import { REGISTRY_REPO, REGISTRY_GITHUB_URL } from '@/src/utils/registry/constants';
import { Command } from 'commander';
import { execa } from 'execa';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prompts from 'prompts';
// Import performCliUpdate directly from update instead of update-cli
import { performCliUpdate } from './update';

// Registry integration constants
const REGISTRY_PACKAGES_PATH = 'packages';
const LOCAL_REGISTRY_PATH = 'packages/registry';

/**
 * Package metadata interface
 */
interface PackageMetadata {
  name: string;
  version: string;
  description: string;
  type: string;
  platform: string;
  runtimeVersion: string;
  repository: string;
  maintainers: string[];
  publishedAt: string;
  publishedBy: string;
  dependencies: Record<string, string>;
  tags: string[];
  license: string;
  npmPackage?: string;
  githubRepo?: string;
}

/**
 * Check if the current CLI version is up to date
 */
async function checkCliVersion() {
  try {
    const cliPackageJsonPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../package.json'
    );

    const cliPackageJsonContent = await fs.readFile(cliPackageJsonPath, 'utf-8');
    const cliPackageJson = JSON.parse(cliPackageJsonContent);
    const currentVersion = cliPackageJson.version || '0.0.0';

    // Get the time data for all published versions to find the most recent
    const { stdout } = await execa('npm', ['view', '@elizaos/cli', 'time', '--json']);
    const timeData = JSON.parse(stdout);

    // Remove metadata entries like 'created' and 'modified'
    delete timeData.created;
    delete timeData.modified;

    // Find the most recently published version
    let latestVersion = '';
    let latestDate = new Date(0); // Start with epoch time

    for (const [version, dateString] of Object.entries(timeData)) {
      const publishDate = new Date(dateString as string);
      if (publishDate > latestDate) {
        latestDate = publishDate;
        latestVersion = version;
      }
    }

    // Compare versions
    if (latestVersion && latestVersion !== currentVersion) {
      console.warn(`CLI update available: ${currentVersion} → ${latestVersion}`);

      const { update } = await prompts({
        type: 'confirm',
        name: 'update',
        message: 'Update CLI before publishing?',
        initial: false,
      });

      if (update) {
        console.info('Updating CLI...');
        // Instead of using npx (which gets blocked), directly call the update function
        try {
          await performCliUpdate();
          // If update is successful, exit
          process.exit(0);
        } catch (updateError) {
          console.error('Failed to update CLI:', updateError);
          // Continue with current version if update fails
        }
      }
    }

    return currentVersion;
  } catch (error) {
    console.warn('Could not check for CLI updates');
    return null;
  }
}

/**
 * Generate package metadata for the registry
 */
async function generatePackageMetadata(
  packageJson,
  cliVersion,
  username
): Promise<PackageMetadata> {
  const metadata: PackageMetadata = {
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description || '',
    type: packageJson.type || 'plugin', // plugin or project
    platform: packageJson.platform || 'universal', // node, browser, or universal
    runtimeVersion: cliVersion, // Compatible CLI/runtime version
    repository: packageJson.repository?.url || '',
    maintainers: packageJson.maintainers || [username],
    publishedAt: new Date().toISOString(),
    publishedBy: username,
    dependencies: packageJson.dependencies || {},
    tags: packageJson.keywords || [],
    license: packageJson.license || 'UNLICENSED',
  };

  // Add npm or GitHub specific data
  if (packageJson.npmPackage) {
    metadata.npmPackage = packageJson.npmPackage;
  }

  if (packageJson.githubRepo) {
    metadata.githubRepo = packageJson.githubRepo;
  }

  // Ensure appropriate tag is included based on type
  if (metadata.type === 'plugin' && !metadata.tags.includes('plugin')) {
    metadata.tags.push('plugin');
  } else if (metadata.type === 'project' && !metadata.tags.includes('project')) {
    metadata.tags.push('project');
  }

  return metadata;
}

/**
 * Check if user is a maintainer for the package
 */
function isMaintainer(packageJson, username) {
  if (!packageJson.maintainers) {
    // If no maintainers specified, the publisher becomes the first maintainer
    return true;
  }

  return packageJson.maintainers.includes(username);
}

/**
 * Update the registry index with the package information
 */
async function updateRegistryIndex(packageMetadata, dryRun = false) {
  try {
    const indexPath = dryRun
      ? path.join(process.cwd(), LOCAL_REGISTRY_PATH, 'index.json')
      : path.join(process.cwd(), 'temp-registry', 'index.json');

    // Create registry directory if it doesn't exist in dry run
    try {
      await fs.access(path.dirname(indexPath));
    } catch {
      await fs.mkdir(path.dirname(indexPath), { recursive: true });
      // Create empty index file if it doesn't exist
      try {
        await fs.access(indexPath);
      } catch {
        await fs.writeFile(
          indexPath,
          JSON.stringify(
            {
              v1: { packages: {} },
              v2: { packages: {} },
            },
            null,
            2
          )
        );
      }
    }

    // Read current index
    let indexContent;
    try {
      indexContent = await fs.readFile(indexPath, 'utf-8');
    } catch (error) {
      // Create default index if it doesn't exist
      indexContent = JSON.stringify({
        v1: { packages: {} },
        v2: { packages: {} },
      });
    }

    const index = JSON.parse(indexContent);

    // Update v2 section of index
    if (!index.v2) {
      index.v2 = { packages: {} };
    }

    if (!index.v2.packages) {
      index.v2.packages = {};
    }

    if (!index.v2.packages[packageMetadata.name]) {
      index.v2.packages[packageMetadata.name] = {
        name: packageMetadata.name,
        description: packageMetadata.description,
        type: packageMetadata.type,
        versions: {},
      };
    }

    // Update package info
    const packageInfo = index.v2.packages[packageMetadata.name];
    packageInfo.description = packageMetadata.description;
    packageInfo.type = packageMetadata.type;

    // Add version
    packageInfo.versions[packageMetadata.version] = {
      version: packageMetadata.version,
      runtimeVersion: packageMetadata.runtimeVersion,
      platform: packageMetadata.platform,
      publishedAt: packageMetadata.publishedAt,
      published: !dryRun,
    };

    // Write updated index
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
    console.info(
      `Registry index ${dryRun ? '(dry run) ' : ''}updated with ${packageMetadata.name}@${packageMetadata.version}`
    );

    return true;
  } catch (error) {
    console.error(`Failed to update registry index: ${error.message}`);
    return false;
  }
}

/**
 * Save package metadata to registry
 */
async function savePackageToRegistry(packageMetadata, dryRun = false) {
  try {
    // Define paths
    const packageDir = dryRun
      ? path.join(process.cwd(), LOCAL_REGISTRY_PATH, REGISTRY_PACKAGES_PATH, packageMetadata.name)
      : path.join(process.cwd(), 'temp-registry', REGISTRY_PACKAGES_PATH, packageMetadata.name);
    const metadataPath = path.join(packageDir, `${packageMetadata.version}.json`);

    // Create directory if it doesn't exist
    await fs.mkdir(packageDir, { recursive: true });

    // Write metadata file
    await fs.writeFile(metadataPath, JSON.stringify(packageMetadata, null, 2));

    console.info(`Package metadata ${dryRun ? '(dry run) ' : ''}saved to ${metadataPath}`);

    // Update index file
    await updateRegistryIndex(packageMetadata, dryRun);

    return true;
  } catch (error) {
    console.error(`Failed to save package metadata: ${error.message}`);
    return false;
  }
}

/**
 * Get or prompt for NPM username and ensure authentication
 */
async function getNpmUsername(): Promise<string> {
  console.info(
    'NPM authentication required for registry compliance (package name must match potential NPM package).'
  );

  try {
    // Check if already logged in
    const { stdout } = await execa('npm', ['whoami']);
    const currentUser = stdout.trim();
    console.info(`Found existing NPM login: ${currentUser}`);

    // Ask if they want to use this account or login with a different one
    const { useExisting } = await prompts({
      type: 'confirm',
      name: 'useExisting',
      message: `Use NPM account "${currentUser}" for package naming?`,
      initial: true,
    });

    if (useExisting) {
      return currentUser;
    } else {
      // They want to use a different account, prompt for login
      console.info('Please login with your desired NPM account...');
      await execa('npm', ['login'], { stdio: 'inherit' });

      // Get the new username after login
      const { stdout: newStdout } = await execa('npm', ['whoami']);
      const newUser = newStdout.trim();
      console.info(`Logged in as: ${newUser}`);
      return newUser;
    }
  } catch (error) {
    // Not logged in, prompt for login
    console.info('Not logged into NPM. Please login to continue...');
    try {
      await execa('npm', ['login'], { stdio: 'inherit' });

      // Get username after successful login
      const { stdout } = await execa('npm', ['whoami']);
      const username = stdout.trim();
      console.info(`Successfully logged in as: ${username}`);
      return username;
    } catch (loginError) {
      console.error('NPM login failed. Registry compliance requires a valid NPM account.');
      process.exit(1);
    }
  }
}

/**
 * Display appropriate registry publication messaging based on options and user status
 */
function displayRegistryPublicationMessage(
  opts: { skipRegistry?: boolean; npm?: boolean },
  userIsMaintainer: boolean,
  registryPrUrl?: string
): void {
  // Early returns for clear flow control
  if (opts.skipRegistry) {
    console.info('Registry publication skipped as requested with --skip-registry flag');
    return;
  }

  if (opts.npm) {
    // NPM-only publishing with registry enabled
    console.warn('NPM publishing currently does not update the registry.');
    console.info('To include this package in the registry:');
    console.info(`1. Fork the registry repository at ${REGISTRY_GITHUB_URL}`);
    console.info('2. Add your package metadata');
    console.info('3. Submit a pull request to the main repository');
    return;
  }

  // GitHub + registry publishing
  if (userIsMaintainer) {
    // For GitHub publishing, PR is already created by publishToGitHub
    if (!registryPrUrl) {
      console.info('Registry publication completed during GitHub publishing process.');
    }
  } else {
    // For non-maintainers, show instructions for registry inclusion
    console.info("Package published, but you're not a maintainer of this package.");
    console.info('To include this package in the registry, please:');
    console.info(`1. Fork the registry repository at ${REGISTRY_GITHUB_URL}`);
    console.info('2. Add your package metadata');
    console.info('3. Submit a pull request to the main repository');
  }
}

/**
 * Validate plugin requirements
 */
async function validatePluginRequirements(cwd: string, packageJson: any): Promise<void> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check plugin naming convention (this is still a hard error)
  const packageName = packageJson.name.split('/').pop() || packageJson.name;
  if (!packageName.startsWith('plugin-')) {
    errors.push(
      'Plugin name must start with "plugin-". Please update your package name and try again.'
    );
  }

  // Check if description is still the default generated one (warning)
  const pluginDirName = path.basename(cwd);
  const expectedDefaultDesc = `ElizaOS plugin for ${pluginDirName.replace('plugin-', '')}`;
  if (
    packageJson.description === expectedDefaultDesc ||
    packageJson.description === '${PLUGINDESCRIPTION}'
  ) {
    warnings.push(
      'Description appears to be the default generated description. Consider writing a custom description.'
    );
  }

  // Check for required images (warnings)
  const imagesDir = path.join(cwd, 'images');
  const logoPath = path.join(imagesDir, 'logo.jpg');
  const bannerPath = path.join(imagesDir, 'banner.jpg');

  try {
    await fs.access(logoPath);
  } catch {
    warnings.push('Missing required logo.jpg in images/ directory (400x400px, max 500KB).');
  }

  try {
    await fs.access(bannerPath);
  } catch {
    warnings.push('Missing required banner.jpg in images/ directory (1280x640px, max 1MB).');
  }

  // Handle hard errors (must be fixed)
  if (errors.length > 0) {
    console.error('Plugin validation failed:');
    errors.forEach((error) => console.error(`  - ${error}`));
    console.error('\nPlease fix these issues and try publishing again.');
    process.exit(1);
  }

  // Handle warnings (can be bypassed)
  if (warnings.length > 0) {
    console.warn('Plugin validation warnings:');
    warnings.forEach((warning) => console.warn(`  - ${warning}`));
    console.warn('Your plugin may get rejected if you submit without addressing these issues.');

    const { proceed } = await prompts({
      type: 'confirm',
      name: 'proceed',
      message: 'Do you wish to continue anyway?',
      initial: false,
    });

    if (!proceed) {
      console.info('Publishing cancelled. Please address the warnings and try again.');
      process.exit(0);
    }
  }
}

export const publish = new Command()
  .name('publish')
  .description('Publish a plugin to npm, GitHub, and the registry')
  .option('-n, --npm', 'publish to npm only (skip GitHub and registry)', false)
  .option('-t, --test', 'test publish process without making changes', false)
  .option('-d, --dry-run', 'generate registry files locally without publishing', false)
  .option('-sr, --skip-registry', 'skip publishing to the registry', false)
  .hook('preAction', async () => {
    await displayBanner();
  })
  .action(async (opts) => {
    try {
      const cwd = process.cwd();

      // Use standardized directory detection
      const directoryInfo = detectDirectoryType(cwd);

      // Validate that we're in a valid directory with package.json
      if (!directoryInfo.hasPackageJson) {
        console.error(
          `No package.json found in current directory. This directory is: ${getDirectoryTypeDescription(directoryInfo)}`
        );
        process.exit(1);
      }

      // Check for CLI updates
      const cliVersion = await checkCliVersion();

      // Get the plugin directory name (should be plugin-*)
      const pluginDirName = path.basename(process.cwd());

      // Validate we're in a plugin directory
      if (!pluginDirName.startsWith('plugin-')) {
        console.error('This command must be run from a plugin directory (plugin-*)');
        process.exit(1);
      }

      // Validate data directory and settings only if we need GitHub publishing
      if (!opts.npm) {
        const isValid = await validateDataDir();
        if (!isValid) {
          console.info('\nGitHub credentials required for publishing.');
          console.info("You'll need a GitHub Personal Access Token with these scopes:");
          console.info('  * repo (for repository access)');
          console.info('  * read:org (for organization access)');
          console.info('  * workflow (for workflow access)\n');

          // Initialize data directory first
          await initializeDataDir();

          // Use the built-in credentials function
          const credentials = await getGitHubCredentials();
          if (!credentials) {
            console.error('GitHub credentials setup cancelled.');
            process.exit(1);
          }

          // Revalidate after saving credentials
          const revalidated = await validateDataDir();
          if (!revalidated) {
            console.error('Failed to validate credentials after saving.');
            process.exit(1);
          }
        }
      }

      // Read package.json
      const packageJsonPath = path.join(cwd, 'package.json');
      const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(packageJsonContent);

      if (!packageJson.name || !packageJson.version) {
        console.error('Invalid package.json: missing name or version.');
        process.exit(1);
      }

      // Use standardized directory detection for type determination
      let detectedType: string;

      if (directoryInfo.type === 'elizaos-plugin') {
        detectedType = 'plugin';
        console.info('Detected ElizaOS plugin using standardized directory detection');
      } else if (directoryInfo.type === 'elizaos-project') {
        detectedType = 'project';
        console.info('Detected ElizaOS project using standardized directory detection');
      } else {
        // Fallback for backwards compatibility - check package.json fields
        detectedType = 'plugin'; // Default to plugin

        if (packageJson.agentConfig?.pluginType) {
          const pluginType = packageJson.agentConfig.pluginType.toLowerCase();
          if (pluginType.includes('project')) {
            detectedType = 'project';
            console.info('Detected project from package.json agentConfig.pluginType');
          }
        } else if (packageJson.eliza?.type === 'project') {
          detectedType = 'project';
          console.info('Detected project from package.json eliza.type (legacy format)');
        } else if (packageJson.packageType === 'project') {
          detectedType = 'project';
          console.info('Detected project from package.json packageType field');
        } else {
          console.info(
            `Defaulting to plugin type. Directory detected as: ${getDirectoryTypeDescription(directoryInfo)}`
          );
        }
      }

      // Add packageType and platform to package.json for publishing
      packageJson.packageType = detectedType;
      packageJson.platform ??= 'node'; // Default to 'node' platform if not specified

      // Preserve agentConfig if it exists or create it
      if (!packageJson.agentConfig) {
        packageJson.agentConfig = {
          pluginType: detectedType === 'plugin' ? 'elizaos:plugin:1.0.0' : 'elizaos:project:1.0.0',
          pluginParameters: {},
        };
      } else if (!packageJson.agentConfig.pluginType) {
        // Ensure pluginType is set based on detection
        packageJson.agentConfig.pluginType =
          detectedType === 'plugin' ? 'elizaos:plugin:1.0.0' : 'elizaos:project:1.0.0';
      }

      // For plugin type, validate naming convention
      if (detectedType === 'plugin' && !packageJson.name.includes('plugin-')) {
        console.warn(
          "This doesn't appear to be an ElizaOS plugin. Package name should include 'plugin-'."
        );
        const { proceed } = await prompts({
          type: 'confirm',
          name: 'proceed',
          message: 'Proceed anyway?',
          initial: false,
        });

        if (!proceed) {
          process.exit(0);
        }
      }

      // Get GitHub credentials only if we need them (not npm-only mode)
      let credentials = null;
      if (!opts.npm) {
        credentials = await getGitHubCredentials();
        if (!credentials) {
          console.error('GitHub credentials required for publishing.');
          process.exit(1);
        }
      }

      // Get NPM username for registry compliance
      const npmUsername = await getNpmUsername();
      console.info(`Using NPM username: ${npmUsername}`);

      // Replace ALL placeholders in package.json
      console.info('Updating package.json with actual values...');

      const placeholderReplacements = {
        // Name placeholders
        'npm-username': {
          check: () => packageJson.name.includes('npm-username'),
          replace: () => {
            packageJson.name = packageJson.name.replace('npm-username', npmUsername);
            console.info(`Set package org: @${npmUsername}`);
          },
        },
        'plugin-name': {
          check: () => packageJson.name.includes('plugin-name'),
          replace: () => {
            packageJson.name = packageJson.name.replace('plugin-name', pluginDirName);
            console.info(`Set package name: ${packageJson.name}`);
          },
        },
        // Description placeholder
        '${PLUGINDESCRIPTION}': {
          check: () => packageJson.description === '${PLUGINDESCRIPTION}',
          replace: () => {
            const simpleName = pluginDirName.replace('plugin-', '');
            packageJson.description = `ElizaOS plugin for ${simpleName}`;
            console.info(`Set description: ${packageJson.description}`);
          },
        },
        // Repository URL placeholder (only for GitHub publishing)
        '${REPO_URL}': {
          check: () =>
            !opts.npm &&
            credentials &&
            packageJson.repository &&
            (packageJson.repository.url === '${REPO_URL}' || packageJson.repository.url === ''),
          replace: () => {
            if (!packageJson.repository) {
              packageJson.repository = { type: 'git', url: '' };
            }
            packageJson.repository.url = `github:${credentials.username}/${pluginDirName}`;
            console.info(`Set repository: ${packageJson.repository.url}`);
          },
        },
        // Author placeholder (only for GitHub publishing)
        '${GITHUB_USERNAME}': {
          check: () => !opts.npm && credentials && packageJson.author === '${GITHUB_USERNAME}',
          replace: () => {
            packageJson.author = credentials.username;
            console.info(`Set author: ${packageJson.author}`);
          },
        },
        // Bugs URL placeholder (only for GitHub publishing)
        'bugs-placeholder': {
          check: () =>
            !opts.npm &&
            credentials &&
            packageJson.bugs &&
            packageJson.bugs.url &&
            packageJson.bugs.url.includes('${GITHUB_USERNAME}'),
          replace: () => {
            packageJson.bugs.url = packageJson.bugs.url
              .replace('${GITHUB_USERNAME}', credentials.username)
              .replace('${PLUGINNAME}', pluginDirName);
            console.info(`Set bugs URL: ${packageJson.bugs.url}`);
          },
        },
      };

      // Apply all placeholder replacements
      Object.entries(placeholderReplacements).forEach(([_, replacement]) => {
        if (replacement.check()) {
          replacement.replace();
        }
      });

      // Extract final plugin name for use in publishing
      const finalPluginName = packageJson.name.startsWith('@')
        ? packageJson.name.split('/')[1]
        : packageJson.name;

      // Save updated package.json
      await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf-8');

      // Validate plugin requirements
      await validatePluginRequirements(cwd, packageJson);

      // Update registry settings
      const settings = await getRegistrySettings();
      const publishUsername = credentials ? credentials.username : npmUsername;
      settings.publishConfig = {
        registry: settings.defaultRegistry,
        username: publishUsername,
        useNpm: opts.npm,
        platform: packageJson.platform,
      };
      await saveRegistrySettings(settings);

      // Generate package metadata
      const packageMetadata = await generatePackageMetadata(
        packageJson,
        cliVersion,
        publishUsername
      );
      console.debug('Generated package metadata:', packageMetadata);

      // Check if user is a maintainer
      const userIsMaintainer = isMaintainer(packageJson, publishUsername);
      console.info(
        `User ${publishUsername} is ${userIsMaintainer ? 'a maintainer' : 'not a maintainer'} of this package`
      );

      // Handle dry run mode (create local registry files)
      if (opts.dryRun) {
        console.info(`Running dry run for plugin registry publication...`);

        // Save package to local registry
        const success = await savePackageToRegistry(packageMetadata, true);

        if (success) {
          console.log(
            `[√] Dry run successful: Registry metadata generated for ${packageJson.name}@${packageJson.version}`
          );
          console.info(`Files created in ${LOCAL_REGISTRY_PATH}`);
        } else {
          console.error('Dry run failed');
          process.exit(1);
        }

        return;
      }

      if (opts.test) {
        console.info(`Running plugin publish tests...`);

        if (opts.npm) {
          console.info('\nTesting npm publishing:');
          const npmTestSuccess = await testPublishToNpm(cwd);
          if (!npmTestSuccess) {
            console.error('npm publishing test failed');
            process.exit(1);
          }
        }

        console.info('\nTesting GitHub publishing:');
        const githubTestSuccess = await testPublishToGitHub(cwd, packageJson, credentials.username);

        if (!githubTestSuccess) {
          console.error('GitHub publishing test failed');
          process.exit(1);
        }

        // Test registry publishing
        if (!opts.skipRegistry) {
          console.info('\nTesting registry publishing:');
          const registryTestSuccess = await savePackageToRegistry(packageMetadata, true);

          if (!registryTestSuccess) {
            console.error('Registry publishing test failed');
            process.exit(1);
          }
        } else {
          console.info(
            '\nSkipping registry publishing test as requested with --skip-registry flag'
          );
        }

        console.log('All tests passed successfully!');
        return;
      }

      // Track what was actually published for accurate messaging
      let publishResult: boolean | { success: boolean; prUrl?: string } = false;
      let publishedToGitHub = false;
      let registryPrUrl: string = null;

      // Step 1: Publish to npm (always, unless we add a --skip-npm flag later)
      console.info(`Publishing plugin to npm...`);

      // Update npmPackage field if it's a placeholder or not set
      if (!packageJson.npmPackage || packageJson.npmPackage === '${NPM_PACKAGE}') {
        packageJson.npmPackage = packageJson.name;
        console.info(`Set npmPackage to: ${packageJson.npmPackage}`);

        // Save updated package.json
        await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf-8');
      }

      console.info(`Publishing as npm user: ${npmUsername}`);

      // Build the package
      console.info('Building package...');
      await execa('npm', ['run', 'build'], { cwd, stdio: 'inherit' });

      // Publish to npm with --ignore-scripts to prevent recursion
      console.info('Publishing to npm...');
      await execa('npm', ['publish', '--ignore-scripts'], { cwd, stdio: 'inherit' });

      console.log(`[√] Successfully published ${packageJson.name}@${packageJson.version} to npm`);

      // Add npm package info to metadata
      packageMetadata.npmPackage = packageJson.name;

      // Step 2: Publish to GitHub and registry (unless --npm flag is used for npm-only)
      if (!opts.npm) {
        console.info('Publishing to GitHub and registry...');
        publishResult = await publishToGitHub(
          cwd,
          packageJson,
          cliVersion,
          credentials.username,
          opts.skipRegistry,
          false
        );

        if (!publishResult) {
          process.exit(1);
        }

        publishedToGitHub = true;
        console.log(
          `[√] Successfully published plugin ${packageJson.name}@${packageJson.version} to GitHub`
        );

        // Add GitHub repo info to metadata
        packageMetadata.githubRepo = `${credentials.username}/${finalPluginName}`;

        // Store PR URL if returned from publishToGitHub (only show if registry not skipped)
        if (typeof publishResult === 'object' && publishResult.prUrl && !opts.skipRegistry) {
          registryPrUrl = publishResult.prUrl;
          console.log(`[√] Registry pull request created: ${registryPrUrl}`);
        }
      }

      // Handle registry publication messaging
      displayRegistryPublicationMessage(opts, userIsMaintainer, registryPrUrl);

      console.log(`Successfully published plugin ${packageJson.name}@${packageJson.version}`);

      // Show availability URLs only for platforms where we actually published
      console.log('\nYour plugin is now available at:');
      console.log(`NPM: https://www.npmjs.com/package/${packageJson.name}`);

      if (publishedToGitHub && credentials) {
        console.log(`GitHub: https://github.com/${credentials.username}/${finalPluginName}`);
      }

      console.log('\n[📝] Important: For future updates to your plugin:');
      console.log('   Use standard npm and git workflows, not the ElizaOS CLI:');
      console.log('   1. Make your changes and test locally');
      console.log('   2. Update version: npm version patch|minor|major');
      console.log('   3. Publish to npm: npm publish');
      if (publishedToGitHub) {
        console.log('   4. Push to GitHub: git push origin main && git push --tags');
      }
      console.log('\n   The ElizaOS registry will automatically sync with npm updates.');
      console.log('   Only use "elizaos publish" for initial publishing of new plugins.');
    } catch (error) {
      handleError(error);
    }
  });
