import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGitHubCredentials } from '@/src/utils/github';
import { handleError } from '@/src/utils/handle-error';
import {
  publishToGitHub,
  testPublishToGitHub,
  testPublishToNpm,
} from '@/src/utils/plugin-publisher';
import {
  getRegistrySettings,
  initializeDataDir,
  saveRegistrySettings,
  validateDataDir,
} from '@/src/utils/registry/index';
import { logger } from '@elizaos/core';
import { Command } from 'commander';
import { execa } from 'execa';
import prompts from 'prompts';

export const plugin = new Command()
  .name('plugin')
  .description('Manage ElizaOS plugins, including publishing');

/**
 * Note: The plugin creation functionality is now in the main create.ts file.
 * Use "npx @elizaos/cli create" and select "plugin" when prompted.
 */

plugin
  .command('publish')
  .description('publish a plugin to a registry')
  .option('-r, --registry <registry>', 'target registry', 'elizaOS/registry')
  .option('-n, --npm', 'publish to npm instead of GitHub', false)
  .option('-t, --test', 'test publish process without making changes', false)
  .option(
    '-p, --platform <platform>',
    'specify platform compatibility (node, browser, universal)',
    'universal'
  )
  .action(async (opts) => {
    try {
      const cwd = process.cwd();

      // Validate data directory and settings
      const isValid = await validateDataDir();
      if (!isValid) {
        logger.info('\nGitHub credentials required for publishing.');
        logger.info("You'll need a GitHub Personal Access Token with these scopes:");
        logger.info('  * repo (for repository access)');
        logger.info('  * read:org (for organization access)');
        logger.info('  * workflow (for workflow access)\n');

        // Initialize data directory first
        await initializeDataDir();

        // Use the built-in credentials function
        const credentials = await getGitHubCredentials();
        if (!credentials) {
          logger.error('GitHub credentials setup cancelled.');
          process.exit(1);
        }

        // Revalidate after saving credentials
        const revalidated = await validateDataDir();
        if (!revalidated) {
          logger.error('Failed to validate credentials after saving.');
          process.exit(1);
        }
      }

      // Check if this is a plugin directory
      const packageJsonPath = path.join(cwd, 'package.json');
      if (!existsSync(packageJsonPath)) {
        logger.error('No package.json found in current directory.');
        process.exit(1);
      }

      // Read package.json
      const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(packageJsonContent);

      if (!packageJson.name || !packageJson.version) {
        logger.error('Invalid package.json: missing name or version.');
        process.exit(1);
      }

      // Validate platform option
      const validPlatforms = ['node', 'browser', 'universal'];
      if (opts.platform && !validPlatforms.includes(opts.platform)) {
        logger.error(
          `Invalid platform: ${opts.platform}. Valid options are: ${validPlatforms.join(', ')}`
        );
        process.exit(1);
      }

      // Add platform to package.json if specified
      if (opts.platform) {
        packageJson.platform = opts.platform;
      }

      // Check if it's an ElizaOS plugin
      if (!packageJson.name.includes('plugin-')) {
        logger.warn(
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

      // Get CLI version for runtime compatibility
      const cliPackageJsonPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../package.json'
      );

      let cliVersion = '0.0.0';
      try {
        const cliPackageJsonContent = await fs.readFile(cliPackageJsonPath, 'utf-8');
        const cliPackageJson = JSON.parse(cliPackageJsonContent);
        cliVersion = cliPackageJson.version || '0.0.0';
      } catch (error) {
        logger.warn('Could not determine CLI version, using 0.0.0');
      }

      // Get or prompt for GitHub credentials
      let credentials = await getGitHubCredentials();
      if (!credentials) {
        logger.info('\nGitHub credentials required for publishing.');
        logger.info('Please enter your GitHub credentials:\n');

        await new Promise((resolve) => setTimeout(resolve, 10));

        const newCredentials = await getGitHubCredentials();
        if (!newCredentials) {
          process.exit(1);
        }

        credentials = newCredentials;
      }

      // Update registry settings
      const settings = await getRegistrySettings();
      settings.defaultRegistry = opts.registry;
      settings.publishConfig = {
        registry: opts.registry,
        username: credentials.username,
        useNpm: opts.npm,
        platform: opts.platform,
      };
      await saveRegistrySettings(settings);

      if (opts.test) {
        logger.info('Running publish tests...');

        if (opts.npm) {
          logger.info('\nTesting npm publishing:');
          const npmTestSuccess = await testPublishToNpm(cwd);
          if (!npmTestSuccess) {
            logger.error('npm publishing test failed');
            process.exit(1);
          }
        }

        logger.info('\nTesting GitHub publishing:');
        const githubTestSuccess = await testPublishToGitHub(cwd, packageJson, credentials.username);

        if (!githubTestSuccess) {
          logger.error('GitHub publishing test failed');
          process.exit(1);
        }

        logger.success('All tests passed successfully!');
        return;
      }

      // Handle npm publishing
      if (opts.npm) {
        logger.info('Publishing to npm...');

        // Check if logged in to npm
        try {
          await execa('npm', ['whoami'], { stdio: 'inherit' });
        } catch (error) {
          logger.error("Not logged in to npm. Please run 'npm login' first.");
          process.exit(1);
        }

        // Build the package
        logger.info('Building package...');
        await execa('npm', ['run', 'build'], { cwd, stdio: 'inherit' });

        // Publish to npm
        logger.info('Publishing to npm...');
        await execa('npm', ['publish'], { cwd, stdio: 'inherit' });

        logger.success(`Successfully published ${packageJson.name}@${packageJson.version} to npm`);
        return;
      }

      // Handle GitHub publishing
      const success = await publishToGitHub(
        cwd,
        packageJson,
        cliVersion,
        credentials.username,
        false
      );

      if (!success) {
        process.exit(1);
      }

      logger.success(`Successfully published ${packageJson.name}@${packageJson.version}`);
    } catch (error) {
      handleError(error);
    }
  });
