import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProject } from '@/src/utils/build-project';
import { copyTemplate } from '@/src/utils/copy-template';
import { handleError } from '@/src/utils/handle-error';
import { runBunCommand } from '@/src/utils/run-bun';
import { logger } from '@elizaos/core';
import { Command } from 'commander';
import { execa } from 'execa';
import prompts from 'prompts';
import colors from 'yoctocolors';
import { z } from 'zod';

/**
 * This module handles creating both projects and plugins.
 *
 * Previously, plugin creation was handled by the "plugins create" command,
 * but that has been unified with project creation in this single command.
 * Users are now prompted to select which type they want to create.
 *
 * The workflow includes:
 * 1. Asking if the user wants to create a project or plugin
 * 2. Getting the name and creating a directory
 * 3. Setting up proper templates and configurations
 * 4. Installing dependencies
 * 5. Automatically changing directory to the created project/plugin
 * 6. Showing the user the next steps
 */

const initOptionsSchema = z.object({
  dir: z.string().default('.'),
  yes: z.boolean().default(false),
  type: z.enum(['project', 'plugin']).default('project'),
});

/**
 * Local implementation of getAvailableDatabases that doesn't require GitHub credentials.
 * This is used during project creation to avoid prompting for credentials.
 *
 * @returns {Promise<string[]>} Array of available databases
 */
async function getLocalAvailableDatabases(): Promise<string[]> {
  // Hard-coded list of available databases to avoid GitHub API calls
  return [
    'pglite',
    'postgres',
    // "sqlite",
    // "supabase"
  ];
}

/**
 * Installs dependencies for the specified target directory, database, and selected plugins.
 * @param {string} targetDir - The directory where dependencies will be installed.
 * @param {string} database - The database for which the adapter will be installed.
 * @param {string[]} selectedPlugins - An array of selected plugins to be installed.
 * @returns {Promise<void>} A promise that resolves once all dependencies are installed.
 */
async function installDependencies(targetDir: string) {
  logger.info('Installing dependencies...');

  // Install bun if not already installed
  try {
    await execa('npm', ['install', '-g', 'bun'], {
      stdio: 'inherit',
    });
  } catch (_error) {
    logger.warn('Failed to install bun globally. Continuing with installation...');
  }

  // First just install basic dependencies
  try {
    await runBunCommand(['install', '--no-optional'], targetDir);
    logger.success('Installed base dependencies');
  } catch (error) {
    logger.warn("Failed to install dependencies automatically. Please run 'bun install' manually.");
  }
}

/**
 * Stores Postgres URL in the global .env file
 * @param url The Postgres URL to store
 */
async function storePostgresUrl(url: string): Promise<void> {
  if (!url) return;

  try {
    const homeDir = os.homedir();
    const globalEnvPath = path.join(homeDir, '.eliza', '.env');

    await fs.writeFile(globalEnvPath, `POSTGRES_URL=${url}\n`, { flag: 'a' });
    logger.success('Postgres URL saved to configuration');
  } catch (error) {
    logger.warn('Error saving database configuration:', error);
  }
}

/**
 * Validates a Postgres URL format
 * @param url The URL to validate
 * @returns True if the URL appears valid
 */
function isValidPostgresUrl(url: string): boolean {
  if (!url) return false;

  // Basic pattern: postgresql://user:password@host:port/dbname
  const basicPattern = /^postgresql:\/\/[^:]+:[^@]+@[^:]+:\d+\/\w+$/;

  // More permissive pattern (allows missing password, different formats)
  const permissivePattern = /^postgresql:\/\/.*@.*:\d+\/.*$/;

  return basicPattern.test(url) || permissivePattern.test(url);
}

/**
 * Prompts the user for a Postgres URL, validates it, and stores it
 * @returns The configured Postgres URL or null if user skips
 */
async function promptAndStorePostgresUrl(): Promise<string | null> {
  let isValidUrl = false;
  let userUrl = '';

  while (!isValidUrl) {
    // Prompt for postgres url with simpler message
    const reply = await prompts({
      type: 'text',
      name: 'postgresUrl',
      message: 'Enter your Postgres URL:',
      validate: (value) => value.trim() !== '' || 'Postgres URL cannot be empty',
    });

    // Handle cancellation
    if (!reply.postgresUrl) {
      const { continueAnyway } = await prompts({
        type: 'confirm',
        name: 'continueAnyway',
        message: 'Continue without configuring Postgres?',
        initial: false,
      });

      if (continueAnyway) return null;
      continue;
    }

    userUrl = reply.postgresUrl;

    // Validate URL format
    if (!isValidPostgresUrl(userUrl)) {
      logger.warn("The URL format doesn't appear to be valid.");
      logger.info('Expected format: postgresql://user:password@host:port/dbname');

      const { useAnyway } = await prompts({
        type: 'confirm',
        name: 'useAnyway',
        message: 'Use this URL anyway? (Choose Yes if you have a custom setup)',
        initial: false,
      });

      if (!useAnyway) continue;
    }

    isValidUrl = true;
  }

  if (userUrl) {
    await storePostgresUrl(userUrl);
    return userUrl;
  }

  return null;
}

/**
 * Initialize a new project or plugin.
 *
 * @param {Object} opts - Options for initialization.
 * @param {string} opts.dir - Installation directory.
 * @param {boolean} opts.yes - Skip confirmation.
 * @param {string} opts.type - Type of template to use (project or plugin).
 *
 * @returns {Promise<void>} Promise that resolves once the initialization process is complete.
 */
export const create = new Command()
  .name('create')
  .description('Initialize a new project or plugin')
  .option('-d, --dir <dir>', 'installation directory', '.')
  .option('-y, --yes', 'skip confirmation', false)
  .option('-t, --type <type>', 'type of template to use (project or plugin)', '')
  .action(async (opts) => {
    try {
      // Parse options but use "" as the default for type to force prompting
      const initialOptions = {
        dir: opts.dir || '.',
        yes: opts.yes || false,
        type: opts.type || '',
      };

      // Prompt for project type if not specified
      let projectType = initialOptions.type;
      if (!projectType) {
        const { type } = await prompts({
          type: 'select',
          name: 'type',
          message: 'What would you like to create?',
          choices: [
            { title: 'Project - Contains agents and plugins', value: 'project' },
            {
              title: 'Plugin - Can be added to the registry and installed by others',
              value: 'plugin',
            },
          ],
          initial: 0,
        });

        if (!type) {
          process.exit(0);
        }

        projectType = type;
      }

      // Now validate with zod after we've determined the type
      const options = initOptionsSchema.parse({
        ...initialOptions,
        type: projectType,
      });

      // Try to find .env file by recursively checking parent directories
      const envPath = path.join(process.cwd(), '.env');

      let currentPath = envPath;
      let depth = 0;
      const maxDepth = 10;

      let postgresUrl = null;

      while (depth < maxDepth && currentPath.includes(path.sep)) {
        if (existsSync(currentPath)) {
          const env = readFileSync(currentPath, 'utf8');
          const envVars = env.split('\n').filter((line) => line.trim() !== '');
          const postgresUrlLine = envVars.find((line) => line.startsWith('POSTGRES_URL='));
          if (postgresUrlLine) {
            postgresUrl = postgresUrlLine.split('=')[1].trim();
            break;
          }
        }

        // Move up one directory by getting the parent directory path
        // First get the directory containing the current .env file
        const currentDir = path.dirname(currentPath);
        // Then move up one directory from there
        const parentDir = path.dirname(currentDir);
        currentPath = path.join(parentDir, '.env');
        depth++;
      }
      // Prompt for project/plugin name
      const { name } = await prompts({
        type: 'text',
        name: 'name',
        message: `What would you like to name your ${options.type}?`,
        validate: (value) => value.length > 0 || `${options.type} name is required`,
      });

      if (!name) {
        process.exit(0);
      }

      // Set up target directory
      const targetDir = options.dir === '.' ? path.resolve(name) : path.resolve(options.dir);

      // Create or check directory
      if (!existsSync(targetDir)) {
        await fs.mkdir(targetDir, { recursive: true });
      } else {
        const files = await fs.readdir(targetDir);
        const isEmpty = files.length === 0 || files.every((f) => f.startsWith('.'));

        if (!isEmpty && !options.yes) {
          const { proceed } = await prompts({
            type: 'confirm',
            name: 'proceed',
            message: 'Directory is not empty. Continue anyway?',
            initial: false,
          });

          if (!proceed) {
            process.exit(0);
          }
        }
      }

      // For plugin initialization, we can simplify the process
      if (options.type === 'plugin') {
        const pluginName = name.startsWith('@elizaos/plugin-') ? name : `@elizaos/plugin-${name}`;

        // Copy plugin template
        await copyTemplate('plugin', targetDir, pluginName);

        // Install dependencies
        logger.info('Installing dependencies...');
        try {
          await runBunCommand(['install', '--no-optional'], targetDir);
          logger.success('Dependencies installed successfully!');

          // Build the plugin after installing dependencies
          await buildProject(targetDir, true);
        } catch (_error) {
          logger.warn(
            "Failed to install dependencies automatically. Please run 'bun install' manually."
          );
        }

        // Change to the created directory
        logger.info(`Changing to directory: ${targetDir}`);
        process.chdir(targetDir);

        logger.success('Plugin initialized successfully!');
        logger.info(`\nYour plugin is ready! Here's what you can do next:
1. \`${colors.cyan('npx @elizaos/cli start')}\` to start development
2. \`${colors.cyan('npx @elizaos/cli test')}\` to test your plugin
3. \`${colors.cyan('npx @elizaos/cli plugins publish')}\` to publish your plugin to the registry`);
        return;
      }

      // For project initialization, continue with the regular flow
      // Get available databases and select one
      const availableDatabases = await getLocalAvailableDatabases();

      const { database } = await prompts({
        type: 'select',
        name: 'database',
        message: 'Select your database:',
        choices: availableDatabases
          .sort((a, b) => a.localeCompare(b))
          .map((db) => ({
            title: db,
            value: db,
          })),
        initial: availableDatabases.indexOf('pglite'),
      });

      if (!database) {
        logger.error('No database selected');
        process.exit(1);
      }

      // Copy project template
      await copyTemplate('project', targetDir, name);

      // Create a database directory in the user's home folder, similar to start.ts
      let dbPath = '../../pglite'; // Default fallback path
      try {
        // Get the user's home directory
        const homeDir = os.homedir();
        const elizaDir = path.join(homeDir, '.eliza');
        const elizaDbDir = path.join(elizaDir, 'db');

        // Check if .eliza directory exists, create if not
        if (!existsSync(elizaDir)) {
          logger.info(`Creating .eliza directory at: ${elizaDir}`);
          await fs.mkdir(elizaDir, { recursive: true });
        }

        // Check if db directory exists in .eliza, create if not
        if (!existsSync(elizaDbDir)) {
          logger.info(`Creating db directory at: ${elizaDbDir}`);
          await fs.mkdir(elizaDbDir, { recursive: true });
        }

        // Use the db directory path
        dbPath = elizaDbDir;
        logger.debug(`Using database directory: ${dbPath}`);
      } catch (error) {
        logger.warn(
          'Failed to create database directory in home directory, using fallback location:',
          error
        );
        // On failure, use the fallback path
      }

      if (database === 'postgres' && !postgresUrl) {
        postgresUrl = await promptAndStorePostgresUrl();
      }

      // Set up src directory
      const srcDir = path.join(targetDir, 'src');
      if (!existsSync(srcDir)) {
        await fs.mkdir(srcDir);
      }

      // Create knowledge directory
      await fs.mkdir(path.join(targetDir, 'knowledge'), { recursive: true });

      // Install dependencies
      await installDependencies(targetDir);

      // Build the project after installing dependencies
      await buildProject(targetDir);

      logger.success('Project initialized successfully!');

      // Show next steps with updated message
      logger.info(`\nYour project is ready! Here's what you can do next:
1. \`cd ${targetDir}\` to change into your project directory
2. Run \`npx @elizaos/cli start\` to start your project
3. Visit \`http://localhost:3000\` to view your project in the browser`);

      // exit successfully
      // Set the user's shell working directory before exiting
      // Note: This only works if the CLI is run with shell integration
      process.stdout.write(`\u001B]1337;CurrentDir=${targetDir}\u0007`);
      process.exit(0);
    } catch (error) {
      handleError(error);
    }
  });
