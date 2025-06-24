import {
  displayBanner,
  getGitHubCredentials,
  handleError,
  testPublishToGitHub,
  testPublishToNpm,
} from '@/src/utils';
import {
  getRegistrySettings,
  initializeDataDir,
  saveRegistrySettings,
  validateDataDir,
} from '@/src/utils/registry/index';
import { detectDirectoryType } from '@/src/utils/directory-detection';
import { Command } from 'commander';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as clack from '@clack/prompts';

// Import modular actions
import { publishToNpm } from './actions/npm-publish';
import { publishToGitHubAction } from './actions/github-publish';
import { savePackageToRegistry } from './actions/registry-publish';

// Import utilities
import {
  validatePluginRequirements,
  isMaintainer,
  displayRegistryPublicationMessage,
} from './utils/validation';
import { generatePackageMetadata } from './utils/metadata';
import { getNpmUsername } from './utils/authentication';
import { checkCliVersion } from './utils/version-check';

// Import types
import { PublishOptions, PackageJson, Credentials, PlaceholderReplacement } from './types';

// Constants
const LOCAL_REGISTRY_PATH = 'packages/registry';

export const publish = new Command()
  .name('publish')
  .description('Publish a plugin to npm, GitHub, and the registry')
  .option('--npm', 'publish to npm only (skip GitHub and registry)', false)
  .option('-t, --test', 'test publish process without making changes', false)
  .option('-d, --dry-run', 'generate registry files locally without publishing', false)
  .option('--skip-registry', 'skip publishing to the registry', false)
  .hook('preAction', async () => {
    await displayBanner();
  })
  .action(async (opts: PublishOptions) => {
    try {
      const cwd = process.cwd();

      // Use standardized directory detection
      const directoryInfo = detectDirectoryType(cwd);

      // Validate that we're in a valid directory with package.json
      if (!directoryInfo || !directoryInfo.hasPackageJson) {
        console.error(
          `No package.json found in current directory. This directory is: ${directoryInfo?.type || 'invalid or inaccessible'}`
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
      const packageJson: PackageJson = JSON.parse(packageJsonContent);

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
          console.info(`Defaulting to plugin type. Directory detected as: ${directoryInfo.type}`);
        }
      }

      // Add packageType and platform to package.json for publishing
      packageJson.packageType = detectedType as 'plugin' | 'project';
      packageJson.platform ??= 'node' as const; // Default to 'node' platform if not specified

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
        const proceed = await clack.confirm({
          message: 'Proceed anyway?',
          initialValue: false,
        });

        if (clack.isCancel(proceed)) {
          clack.cancel('Operation cancelled.');
          process.exit(0);
        }

        if (!proceed) {
          process.exit(0);
        }
      }

      // Get GitHub credentials only if we need them (not npm-only mode)
      let credentials: Credentials | null = null;
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

      const placeholderReplacements: Record<string, PlaceholderReplacement> = {
        // Template default name replacement
        'elizaos-plugin-starter': {
          check: () => packageJson.name === '@elizaos/plugin-starter',
          replace: () => {
            packageJson.name = `@${npmUsername}/${pluginDirName}`;
            console.info(`Set package name: ${packageJson.name}`);
          },
        },
        // Name placeholders (for custom templates)
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
            !!(
              !opts.npm &&
              credentials &&
              packageJson.repository &&
              (packageJson.repository.url === '${REPO_URL}' || packageJson.repository.url === '')
            ),
          replace: () => {
            if (!packageJson.repository) {
              packageJson.repository = { type: 'git', url: '' };
            }
            if (credentials) {
              packageJson.repository.url = `git+https://github.com/${credentials.username}/${pluginDirName}.git`;
              console.info(`Set repository: ${packageJson.repository.url}`);
            }
          },
        },
        // Author placeholder (only for GitHub publishing)
        '${GITHUB_USERNAME}': {
          check: () => !!(!opts.npm && credentials && packageJson.author === '${GITHUB_USERNAME}'),
          replace: () => {
            if (credentials) {
              packageJson.author = credentials.username;
              console.info(`Set author: ${packageJson.author}`);
            }
          },
        },
        // Bugs URL placeholder (only for GitHub publishing)
        'bugs-placeholder': {
          check: () =>
            !!(
              !opts.npm &&
              credentials &&
              packageJson.bugs &&
              packageJson.bugs.url &&
              packageJson.bugs.url.includes('${GITHUB_USERNAME}')
            ),
          replace: () => {
            if (packageJson.bugs?.url && credentials) {
              packageJson.bugs.url = packageJson.bugs.url
                .replace('${GITHUB_USERNAME}', credentials.username)
                .replace('${PLUGINNAME}', pluginDirName);
              console.info(`Set bugs URL: ${packageJson.bugs.url}`);
            }
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
        const githubTestSuccess = await testPublishToGitHub(
          packageJson,
          credentials?.username || ''
        );

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
      let registryPrUrl: string | null = null;

      // Step 1: Publish to npm (always, unless we add a --skip-npm flag later)
      console.info(`Publishing plugin to npm...`);
      await publishToNpm(cwd, packageJson, npmUsername);

      // Add npm package info to metadata
      packageMetadata.npmPackage = packageJson.name;

      // Step 2: Publish to GitHub and registry (unless --npm flag is used for npm-only)
      if (!opts.npm && credentials) {
        try {
          publishResult = await publishToGitHubAction(
            cwd,
            packageJson,
            credentials,
            opts.skipRegistry,
            false
          );

          if (!publishResult) {
            process.exit(1);
          }

          publishedToGitHub = true;

          // Add GitHub repo info to metadata
          packageMetadata.githubRepo = `${credentials.username}/${finalPluginName}`;

          // Store PR URL if returned from publishToGitHub (only show if registry not skipped)
          if (typeof publishResult === 'object' && publishResult.prUrl && !opts.skipRegistry) {
            registryPrUrl = publishResult.prUrl;
            console.log(`[√] Registry pull request created: ${registryPrUrl}`);
          }
        } catch (error) {
          console.error('GitHub publishing failed:', error);
          process.exit(1);
        }
      }

      // Handle registry publication messaging
      displayRegistryPublicationMessage(opts, userIsMaintainer, registryPrUrl || undefined);

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

// Re-export for backward compatibility
export * from './actions/npm-publish';
export * from './actions/github-publish';
export * from './actions/registry-publish';
export * from './utils/validation';
export * from './utils/metadata';
export * from './utils/authentication';
export * from './utils/version-check';
export * from './types';
