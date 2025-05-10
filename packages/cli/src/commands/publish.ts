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
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prompts from 'prompts';
// Import performCliUpdate directly for updating CLI
import { performCliUpdate } from './update-cli';

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
    if (dryRun && !existsSync(path.dirname(indexPath))) {
      await fs.mkdir(path.dirname(indexPath), { recursive: true });
      // Create empty index file if it doesn't exist
      if (!existsSync(indexPath)) {
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

export const publish = new Command()
  .name('publish')
  .description('Publish a plugin or project to the registry')
  .option('-r, --registry <registry>', 'target registry', 'elizaOS/registry')
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
      if (!existsSync(packageJsonPath)) {
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
              if (existsSync(mainPath)) {
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

      // Ensure repository URL is in the correct format for GitHub
      if (!opts.npm) {
        // Only if we're publishing to GitHub
        // Extract the package name without scope
        const packageName = packageJson.name.replace(/^@elizaos\//, '');

        if (!packageJson.repository) {
          // If repository field doesn't exist, create it
          packageJson.repository = {
            type: 'git',
            url: `github:${credentials.username}/${packageName}`,
          };
          console.info(`Set repository URL to: ${packageJson.repository.url}`);
        } else if (
          !packageJson.repository.url ||
          !packageJson.repository.url.includes(credentials.username)
        ) {
          // Update repository URL to include the correct username
          packageJson.repository.url = `github:${credentials.username}/${packageName}`;
          console.info(`Updated repository URL to: ${packageJson.repository.url}`);
        }

        // Save updated package.json
        await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf-8');
      }

      // Update registry settings
      const settings = await getRegistrySettings();
      settings.defaultRegistry = opts.registry;
      settings.publishConfig = {
        registry: opts.registry,
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
        console.info(`Running dry run for ${detectedType} registry publication...`);

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
        console.info(`Running ${detectedType} publish tests...`);

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

      // Handle actual publishing

      // Variable to store PR URL if one is created during GitHub publishing
      let publishResult: boolean | { success: boolean; prUrl?: string } = false;
      let registryPrUrl: string = null;

      // Handle npm publishing
      if (opts.npm) {
        console.info(`Publishing ${detectedType} to npm...`);

        // Check if logged in to npm
        try {
          await execa('npm', ['whoami'], { stdio: 'inherit' });
        } catch (error) {
          console.error("Not logged in to npm. Please run 'npm login' first.");
          process.exit(1);
        }

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
          `Successfully published ${detectedType} ${packageJson.name}@${packageJson.version} to GitHub`
        );

        // Add GitHub repo info to metadata
        packageMetadata.githubRepo = `${credentials.username}/${packageJson.name}`;

        // Store PR URL if returned from publishToGitHub
        if (typeof publishResult === 'object' && publishResult.prUrl) {
          registryPrUrl = publishResult.prUrl;
          console.log(`Registry pull request created: ${registryPrUrl}`);
        }
      }

      // Handle registry publication - only for plugins, not for projects
      if (!opts.skipRegistry && detectedType === 'plugin') {
        console.info('Publishing to registry...');

        if (userIsMaintainer) {
          if (!opts.npm) {
            // For GitHub publishing, PR is already created by publishToGitHub
            console.info('Registry PR was created during GitHub publishing process.');
          } else {
            // For npm publishing, we need to use the npm-specific publishing flow
            // In a future version, this should be refactored to use publishToGitHub
            // with npm-specific options instead of duplicating PR creation logic
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
      } else if (detectedType === 'project') {
        console.info('Skipping registry publication for projects');
      } else if (opts.skipRegistry) {
        console.info('Skipping registry publication as requested with --skip-registry flag');
      }

      console.log(
        `Successfully published ${detectedType} ${packageJson.name}@${packageJson.version}`
      );

      // Add a tailored next steps message based on package type
      if (detectedType === 'plugin') {
        console.log('\nYour plugin is now available at:');
        console.log(
          `https://github.com/${credentials.username}/${packageJson.name.replace(/^@elizaos\//, '')}`
        );

        if (!opts.skipRegistry) {
          console.log('\nAfter your registry PR is merged, users will be able to install it with:');
          console.log(`elizaos plugins add ${packageJson.name}`);
        }
      } else {
        console.log('\nYour project is now available at:');
        console.log(
          `https://github.com/${credentials.username}/${packageJson.name.replace(/^@elizaos\//, '')}`
        );
        console.log('\nUsers can clone and use your project with:');
        console.log(
          `git clone https://github.com/${credentials.username}/${packageJson.name.replace(/^@elizaos\//, '')}`
        );
      }
    } catch (error) {
      handleError(error);
    }
  });
