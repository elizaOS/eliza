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
import { Command } from 'commander';
import { execa } from 'execa';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prompts from 'prompts';
// Import performCliUpdate directly from update instead of update-cli
import { performCliUpdate } from './update';

// Registry integration constants
const REGISTRY_REPO = 'elizaos/registry';
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
      console.warn(
        `You are using CLI version ${currentVersion}, but the latest version is ${latestVersion} (published ${new Date(timeData[latestVersion]).toLocaleDateString()})`
      );
      console.info(`Run 'elizaos update' to update to the latest version`);

      const { update } = await prompts({
        type: 'confirm',
        name: 'update',
        message: 'Would you like to update now before proceeding?',
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
    console.warn('\nYour plugin may get rejected if you submit without addressing these issues.');

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
  .description('Publish a plugin to the registry)')
  .option('-n, --npm', 'publish to npm instead of GitHub', false)
  .option('-t, --test', 'test publish process without making changes', false)
  .option('-d, --dry-run', 'generate registry files locally without publishing', false)
  .option('-sr, --skip-registry', 'skip publishing to the registry', false)
  .hook('preAction', async () => {
    await displayBanner();
  })
  .action(async (opts) => {
    try {
      const cwd = process.cwd();

      // Check for CLI updates
      const cliVersion = await checkCliVersion();

      // Get the plugin directory name (should be plugin-*)
      const pluginDirName = path.basename(process.cwd());

      // Validate we're in a plugin directory
      if (!pluginDirName.startsWith('plugin-')) {
        console.error('This command must be run from a plugin directory (plugin-*)');
        process.exit(1);
      }

      // Validate data directory and settings
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

      // Check if this is a valid directory with package.json
      const packageJsonPath = path.join(cwd, 'package.json');
      try {
        await fs.access(packageJsonPath);
      } catch {
        console.error('No package.json found in current directory.');
        process.exit(1);
      }

      // Read package.json
      const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(packageJsonContent);

      if (!packageJson.name || !packageJson.version) {
        console.error('Invalid package.json: missing name or version.');
        process.exit(1);
      }

      // Auto-detect whether this is a plugin or project
      let detectedType = 'plugin'; // Default to plugin

      // Check if this is a plugin or project based on package.json
      if (packageJson.agentConfig?.pluginType) {
        // Check if explicitly defined in the agentConfig section
        const pluginType = packageJson.agentConfig.pluginType.toLowerCase();
        if (pluginType.includes('plugin')) {
          detectedType = 'plugin';
          console.info('Detected Eliza plugin in current directory');
        } else if (pluginType.includes('project')) {
          detectedType = 'project';
          console.info('Detected Eliza project in current directory');
        }
      } else if (packageJson.eliza?.type) {
        // For backward compatibility, also check eliza.type
        if (packageJson.eliza.type === 'plugin') {
          detectedType = 'plugin';
          console.info('Detected Eliza plugin in current directory (legacy format)');
        } else if (packageJson.eliza.type === 'project') {
          detectedType = 'project';
          console.info('Detected Eliza project in current directory (legacy format)');
        }
      } else if (packageJson.packageType) {
        // Check packageType field
        if (packageJson.packageType === 'plugin') {
          detectedType = 'plugin';
          console.info('Detected Eliza plugin based on packageType field');
        } else if (packageJson.packageType === 'project') {
          detectedType = 'project';
          console.info('Detected Eliza project based on packageType field');
        }
      } else {
        // Use heuristics to detect the type
        // Check if name contains plugin
        if (packageJson.name.includes('plugin-')) {
          detectedType = 'plugin';
          console.info('Detected plugin based on package name');
        } else if (packageJson.description?.toLowerCase().includes('project')) {
          detectedType = 'project';
          console.info('Detected project based on package description');
        } else {
          // Additional heuristics from start.ts
          try {
            // If the package has a main entry, check if it exports a Project
            const mainEntry = packageJson.main;
            if (mainEntry) {
              const mainPath = path.resolve(cwd, mainEntry);
              try {
                await fs.access(mainPath);
                try {
                  // Try to import the module to see if it's a project or plugin
                  const importedModule = await import(mainPath);

                  // Check for project indicators (agents array or agent property)
                  if (importedModule.default?.agents || importedModule.default?.agent) {
                    detectedType = 'project';
                    console.info('Detected project based on exports');
                  }
                  // Check for plugin indicators
                  else if (
                    importedModule.default?.name &&
                    typeof importedModule.default?.init === 'function'
                  ) {
                    detectedType = 'plugin';
                    console.info('Detected plugin based on exports');
                  }
                } catch (importError) {
                  console.debug(`Error importing module: ${importError}`);
                  // Continue with default type
                }
              } catch {
                // File doesn't exist, skip the import attempt
              }
            }
          } catch (error) {
            console.debug(`Error during type detection: ${error}`);
            // Continue with default type
          }
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

      // Get or prompt for GitHub credentials
      let credentials = await getGitHubCredentials();
      if (!credentials) {
        console.info('\nGitHub credentials required for publishing.');
        console.info('Please enter your GitHub credentials:\n');

        await new Promise((resolve) => setTimeout(resolve, 10));

        const newCredentials = await getGitHubCredentials();
        if (!newCredentials) {
          process.exit(1);
        }

        credentials = newCredentials;
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
        // Repository URL placeholder
        '${REPO_URL}': {
          check: () =>
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
        // Author placeholder
        '${GITHUB_USERNAME}': {
          check: () => packageJson.author === '${GITHUB_USERNAME}',
          replace: () => {
            packageJson.author = credentials.username;
            console.info(`Set author: ${packageJson.author}`);
          },
        },
        // Bugs URL placeholder
        'bugs-placeholder': {
          check: () =>
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
      settings.publishConfig = {
        registry: settings.defaultRegistry,
        username: credentials.username,
        useNpm: opts.npm,
        platform: packageJson.platform,
      };
      await saveRegistrySettings(settings);

      // Generate package metadata
      const packageMetadata = await generatePackageMetadata(
        packageJson,
        cliVersion,
        credentials.username
      );
      console.debug('Generated package metadata:', packageMetadata);

      // Check if user is a maintainer
      const userIsMaintainer = isMaintainer(packageJson, credentials.username);
      console.info(
        `User ${credentials.username} is ${userIsMaintainer ? 'a maintainer' : 'not a maintainer'} of this package`
      );

      // Handle dry run mode (create local registry files)
      if (opts.dryRun) {
        console.info(`Running dry run for plugin registry publication...`);

        // Save package to local registry
        const success = await savePackageToRegistry(packageMetadata, true);

        if (success) {
          console.log(
            `Dry run successful: Registry metadata generated for ${packageJson.name}@${packageJson.version}`
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

      // Variable to store PR URL if one is created during GitHub publishing
      let publishResult: boolean | { success: boolean; prUrl?: string } = false;
      let registryPrUrl: string = null;

      // Handle npm publishing
      if (opts.npm) {
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

        // Publish to npm
        console.info('Publishing to npm...');
        await execa('npm', ['publish'], { cwd, stdio: 'inherit' });

        console.log(`Successfully published ${packageJson.name}@${packageJson.version} to npm`);

        // Add npm package info to metadata
        packageMetadata.npmPackage = packageJson.name;
      } else {
        // Handle GitHub publishing
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

        console.log(
          `Successfully published plugin ${packageJson.name}@${packageJson.version} to GitHub`
        );

        // Add GitHub repo info to metadata
        packageMetadata.githubRepo = `${credentials.username}/${finalPluginName}`;

        // Store PR URL if returned from publishToGitHub
        if (typeof publishResult === 'object' && publishResult.prUrl) {
          registryPrUrl = publishResult.prUrl;
          console.log(`Registry pull request created: ${registryPrUrl}`);
        }
      }

      // Handle registry publication
      if (!opts.skipRegistry) {
        console.info('Publishing to registry...');

        if (userIsMaintainer) {
          if (!opts.npm) {
            // For GitHub publishing, PR is already created by publishToGitHub
            console.info('Registry PR was created during GitHub publishing process.');
          } else {
            // For npm publishing, we need to use the npm-specific publishing flow
            console.warn('NPM publishing currently does not update the registry.');
            console.info('To include this package in the registry:');
            console.info('1. Fork the registry repository at https://github.com/elizaos/registry');
            console.info('2. Add your package metadata');
            console.info('3. Submit a pull request to the main repository');
          }
        } else {
          // For non-maintainers, just show a message about how to request inclusion
          console.info("Package published, but you're not a maintainer of this package.");
          console.info('To include this package in the registry, please:');
          console.info('1. Fork the registry repository at https://github.com/elizaos/registry');
          console.info('2. Add your package metadata');
          console.info('3. Submit a pull request to the main repository');
        }
      } else {
        console.info('Skipping registry publication as requested with --skip-registry flag');
      }

      console.log(`Successfully published plugin ${packageJson.name}@${packageJson.version}`);

      console.log('\nYour plugin is now available at:');
      console.log(`https://github.com/${credentials.username}/${finalPluginName}`);
    } catch (error) {
      handleError(error);
    }
  });
