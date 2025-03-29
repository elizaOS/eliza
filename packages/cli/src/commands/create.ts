import { buildProject } from '@/src/utils/build-project';
import { copyTemplate as copyTemplateUtil } from '@/src/utils/copy-template';
import { checkServer, handleError } from '@/src/utils/handle-error';
import { runBunCommand } from '@/src/utils/run-bun';
import { logger } from '@elizaos/core';
import { Command } from 'commander';
import { execa } from 'execa';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import prompts from 'prompts';
import colors from 'yoctocolors';
import { z } from 'zod';
import { displayBanner } from '../displayBanner';
import { setupPgLite, promptAndStorePostgresUrl, getElizaDirectories } from '../utils/get-config';

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
  .argument('[name]', 'name for the project or plugin')
  .action(async (name, opts) => {
    displayBanner();

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
      } else {
        // Validate the provided type
        if (!['project', 'plugin'].includes(projectType)) {
          logger.error(`Invalid type: ${projectType}. Must be either 'project' or 'plugin'`);
          process.exit(1);
        }
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

      // Prompt for project/plugin name if not provided
      let projectName = name;
      if (!projectName) {
        const { nameResponse } = await prompts({
          type: 'text',
          name: 'nameResponse',
          message: `What would you like to name your ${options.type}?`,
          validate: (value) => value.length > 0 || `${options.type} name is required`,
        });

        if (!nameResponse) {
          process.exit(0);
        }

        projectName = nameResponse;
      }

      // Set up target directory
      // If -d is ".", create in current directory with project name
      // If -d is specified, create project directory inside that directory
      let targetDir = path.join(options.dir === '.' ? process.cwd() : options.dir, projectName);

      // For plugin initialization, we can simplify the process
      if (options.type === 'plugin') {
        // Check if projectName already has plugin- prefix
        if (!projectName.startsWith('plugin-')) {
          // Create a new directory name with the plugin- prefix
          const prefixedName = `plugin-${projectName}`;
          logger.info(
            `Note: Using "${prefixedName}" as the directory name to match package naming convention`
          );

          // Update project name and target directory
          projectName = prefixedName;

          // Update targetDir to use the prefixed name
          targetDir = path.join(options.dir === '.' ? process.cwd() : options.dir, projectName);
        }

        // Now create the directory or check if it exists
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

        // Set the package name with the expected format
        const pluginName = projectName.startsWith('@elizaos/plugin-')
          ? projectName
          : `@elizaos/plugin-${projectName.replace('plugin-', '')}`;

        // Copy plugin template using the utility function
        await copyTemplateUtil('plugin', targetDir, pluginName);

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

        logger.success('Plugin initialized successfully!');

        // Get the relative path for display
        const cdPath =
          options.dir === '.'
            ? projectName // If creating in current directory, just use the name
            : path.relative(process.cwd(), targetDir); // Otherwise use path relative to current directory

        logger.info(`\nYour plugin is ready! Here's your development workflow:

1️⃣ Development
   cd ${cdPath}
   ${colors.cyan('npx elizaos dev')}              # Start development with hot-reloading

2️⃣ Testing
   ${colors.cyan('npx elizaos test')}             # Run automated tests
   ${colors.cyan('npx elizaos start')}            # Test in a live agent environment

3️⃣ Publishing
   ${colors.cyan('npx elizaos plugin publish --test')}    # Check registry requirements
   ${colors.cyan('npx elizaos plugin publish')}           # Submit to registry

📚 Learn more: https://eliza.how/docs/cli/plugins`);

        // Set the user's shell working directory before exiting
        // Note: This only works if the CLI is run with shell integration
        process.stdout.write(`\u001B]1337;CurrentDir=${targetDir}\u0007`);
        return;
      } else {
        // For non-plugin projects, create or check directory now
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
        await copyTemplateUtil('project', targetDir, projectName);

        // Database configuration
        const { elizaDbDir, envFilePath } = getElizaDirectories();

        // Only create directories and configure based on database choice
        if (database === 'pglite') {
          // Set up PGLite directory and configuration
          await setupPgLite(elizaDbDir, envFilePath);
          logger.debug(`Using PGLite database directory: ${elizaDbDir}`);
        } else if (database === 'postgres' && !postgresUrl) {
          // Handle Postgres configuration
          postgresUrl = await promptAndStorePostgresUrl(envFilePath);
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
        const cdPath =
          options.dir === '.'
            ? projectName // If creating in current directory, just use the name
            : path.relative(process.cwd(), targetDir); // Otherwise use path relative to current directory

        logger.info(`\nYour project is ready! Here's what you can do next:
1. \`cd ${cdPath}\` to change into your project directory
2. Run \`npx elizaos start\` to start your project
3. Visit \`http://localhost:3000\` (or your custom port) to view your project in the browser`);

        // exit successfully
        // Set the user's shell working directory before exiting
        // Note: This only works if the CLI is run with shell integration
        process.stdout.write(`\u001B]1337;CurrentDir=${targetDir}\u0007`);
        process.exit(0);
      }
    } catch (error) {
      await checkServer();
      handleError(error);
    }
  });
