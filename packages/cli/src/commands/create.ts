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
import { displayBanner } from '../utils/displayBanner';
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
  console.info('Installing dependencies...');

  // First just install basic dependencies
  try {
    await runBunCommand(['install', '--no-optional'], targetDir);
    console.log('Installed base dependencies');
  } catch (error) {
    console.warn(
      "Failed to install dependencies automatically. Please run 'bun install' manually."
    );
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
  .option('-t, --type <type>', 'type of template to use (project or plugin)', 'project')
  .argument('[name]', 'name for the project or plugin')
  .action(async (name, opts) => {
    // Set non-interactive mode if environment variable is set or if -y/--yes flag is present in process.argv
    if (
      process.env.ELIZA_NONINTERACTIVE === '1' ||
      process.env.ELIZA_NONINTERACTIVE === 'true' ||
      process.argv.includes('-y') ||
      process.argv.includes('--yes')
    ) {
      opts.yes = true;
    } else {
      opts.yes = false;
    }

    // Convert to a proper boolean (if not already)
    opts.yes = opts.yes === true || opts.yes === 'true';

    displayBanner();

    try {
      // Parse options but use "" as the default for type to force prompting
      const initialOptions = {
        dir: opts.dir || '.',
        yes: opts.yes, // Already properly converted to boolean above
        type: opts.type || '',
      };

      // Determine project type, respecting -y
      let projectType = initialOptions.type;
      if (!projectType) {
        if (initialOptions.yes) {
          // Default to project if -y is used and -t is omitted
          projectType = 'project';
          console.info(`Using default type: ${projectType}`);
        } else {
          // Prompt the user if -y is not used
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
      } else {
        // Validate the provided type if -t was used
        if (!['project', 'plugin'].includes(projectType)) {
          console.error(`Invalid type: ${projectType}. Must be either 'project' or 'plugin'`);
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

        // Move up one directory
        const currentDir = path.dirname(currentPath);
        const parentDir = path.dirname(currentDir);
        currentPath = path.join(parentDir, '.env');
        depth++;
      }

      // Prompt for project/plugin name if not provided
      let projectName = name;
      if (!projectName) {
        if (options.yes) {
          projectName = options.type === 'plugin' ? 'myplugin' : 'myproject';
          console.info(`Using default name: ${projectName}`);
        } else {
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
      }

      // Validate project name according to npm package naming rules
      const validateProjectName = (name: string): boolean => {
        // Special case for creating a project in the current directory
        if (name === '.') {
          return true;
        }

        // Check for spaces
        if (name.includes(' ')) {
          return false;
        }

        // Basic npm package name validation (simplified version)
        // Only allow alphanumeric characters, hyphens, and underscores
        // Don't start with a dot or an underscore
        // Don't contain uppercase letters (for consistency)
        const validNameRegex = /^[a-z0-9][-a-z0-9._]*$/;
        return validNameRegex.test(name);
      };

      // Perform name validation
      if (!validateProjectName(projectName)) {
        console.error(colors.red(`Error: Invalid ${options.type} name "${projectName}".`));
        console.error(`${options.type} names must follow npm package naming conventions:`);
        console.error('- Cannot contain spaces');
        console.error('- Must contain only lowercase letters, numbers, hyphens, or underscores');
        console.error('- Cannot start with a dot or underscore');
        process.exit(1);
      }

      // For plugin initialization, add the plugin- prefix if needed
      if (options.type === 'plugin' && !projectName.startsWith('plugin-')) {
        const prefixedName = `plugin-${projectName}`;
        console.info(
          `Note: Using "${prefixedName}" as the directory name to match package naming convention`
        );
        projectName = prefixedName;
      }

      const targetDir = path.join(options.dir === '.' ? process.cwd() : options.dir, projectName);

      // Check if directory already exists and handle accordingly
      if (existsSync(targetDir)) {
        const files = await fs.readdir(targetDir);
        const isEmpty = files.length === 0 || files.every((f) => f.startsWith('.'));

        if (!isEmpty) {
          // Directory exists and is not empty - this should fail
          console.error(
            colors.red(`Error: Directory "${projectName}" already exists and is not empty.`)
          );
          console.error(
            'Please choose a different name or manually remove the directory contents first.'
          );
          process.exit(1);
        } else {
          // Directory exists but is empty - this is fine
          console.info(
            `Note: Directory "${projectName}" already exists but is empty. Continuing...`
          );
        }
      }

      if (options.type === 'plugin') {
        // Create directory if it doesn't exist
        if (!existsSync(targetDir)) {
          await fs.mkdir(targetDir, { recursive: true });
        }

        const pluginName = projectName.startsWith('@elizaos/plugin-')
          ? projectName
          : `@elizaos/plugin-${projectName.replace('plugin-', '')}`;

        await copyTemplateUtil('plugin', targetDir, pluginName);

        console.info('Installing dependencies...');
        try {
          await runBunCommand(['install', '--no-optional'], targetDir);
          console.log('Dependencies installed successfully!');

          // Skip building in test environments to avoid tsup dependency issues
          if (
            process.env.ELIZA_NONINTERACTIVE === '1' ||
            process.env.ELIZA_NONINTERACTIVE === 'true'
          ) {
            console.log('Skipping build in non-interactive mode');
          } else {
            await buildProject(targetDir, true);
          }
        } catch (_error) {
          console.warn(
            "Failed to install dependencies automatically. Please run 'bun install' manually."
          );
        }

        console.log('Plugin initialized successfully!');
        const cdPath = options.dir === '.' ? projectName : path.relative(process.cwd(), targetDir);
        console.info(
          `\nYour plugin is ready! Here's your development workflow:\n\n[1] Development\n   cd ${cdPath}\n   ${colors.cyan('elizaos dev')}                   # Start development with hot-reloading\n\n[2] Testing\n   ${colors.cyan('elizaos test')}                  # Run automated tests\n   ${colors.cyan('elizaos start')}                 # Test in a live agent environment\n\n[3] Publishing\n   ${colors.cyan('elizaos plugin publish --test')} # Check registry requirements\n   ${colors.cyan('elizaos plugin publish')}        # Submit to registry\n\n[?] Learn more: https://eliza.how/docs/cli/plugins`
        );
        process.stdout.write(`\u001B]1337;CurrentDir=${targetDir}\u0007`);
        return;
      } else {
        // Create directory if it doesn't exist
        if (!existsSync(targetDir)) {
          await fs.mkdir(targetDir, { recursive: true });
        }

        const availableDatabases = await getLocalAvailableDatabases();
        let database;
        if (options.yes) {
          database = 'pglite';
          console.info(`Using default database: ${database}`);
        } else {
          const response = await prompts({
            type: 'select',
            name: 'database',
            message: 'Select your database:',
            choices: availableDatabases
              .sort((a, b) => a.localeCompare(b))
              .map((db) => ({ title: db, value: db })),
            initial: availableDatabases.indexOf('pglite'),
          });
          database = response.database;
        }

        if (!database) {
          console.error('No database selected or provided');
          process.exit(1);
        }

        await copyTemplateUtil('project', targetDir, projectName);

        const { elizaDbDir, envFilePath } = getElizaDirectories();
        if (database === 'pglite') {
          await setupPgLite(elizaDbDir, envFilePath);
          console.debug(`Using PGLite database directory: ${elizaDbDir}`);
        } else if (database === 'postgres' && !postgresUrl) {
          postgresUrl = await promptAndStorePostgresUrl(envFilePath);
        }

        const srcDir = path.join(targetDir, 'src');
        if (!existsSync(srcDir)) {
          await fs.mkdir(srcDir);
        }

        await fs.mkdir(path.join(targetDir, 'knowledge'), { recursive: true });
        await installDependencies(targetDir);

        // Skip building in test environments to avoid tsup dependency issues
        if (
          process.env.ELIZA_NONINTERACTIVE === '1' ||
          process.env.ELIZA_NONINTERACTIVE === 'true'
        ) {
          console.log('Skipping build in non-interactive mode');
        } else {
          await buildProject(targetDir);
        }

        console.log('Project initialized successfully!');
        const cdPath = options.dir === '.' ? projectName : path.relative(process.cwd(), targetDir);
        console.info(
          `\nYour project is ready! Here\'s what you can do next:\n1. \`cd ${cdPath}\` to change into your project directory\n2. Run \`elizaos start\` to start your project\n3. Visit \`http://localhost:3000\` (or your custom port) to view your project in the browser`
        );
        process.stdout.write(`\u001B]1337;CurrentDir=${targetDir}\u0007`);
        process.exit(0);
      }
    } catch (error) {
      handleError(error);
    }
  });
