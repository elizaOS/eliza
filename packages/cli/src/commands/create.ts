import {
  buildProject,
  copyTemplate as copyTemplateUtil,
  displayBanner,
  getElizaDirectories,
  handleError,
  promptAndStorePostgresUrl,
  runBunCommand,
  setupPgLite,
  findNearestEnvFile,
} from '@/src/utils';
import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import prompts from 'prompts';
import colors from 'yoctocolors';
import { z } from 'zod';
import { character as elizaCharacter } from '@/src/characters/eliza';

/**
 * This module handles creating projects, plugins, and agent characters.
 *
 * Previously, plugin creation was handled by the "plugins create" command,
 * but that has been unified with project creation in this single command.
 * Users are now prompted to select which type they want to create.
 *
 * The workflow includes:
 * 1. Asking if the user wants to create a project, plugin, or agent
 * 2. Getting the name and creating a directory or file
 * 3. Setting up proper templates and configurations
 * 4. Installing dependencies (for projects/plugins)
 * 5. Automatically changing directory to the created project/plugin
 * 6. Showing the user the next steps
 */

const initOptionsSchema = z.object({
  dir: z.string().default('.'),
  yes: z.boolean().default(false),
  type: z.enum(['project', 'plugin', 'agent']).default('project'),
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
 * Creates .gitignore and .npmignore files in the target directory if they don't exist
 */
async function createIgnoreFiles(targetDir: string): Promise<void> {
  const gitignorePath = path.join(targetDir, '.gitignore');
  const npmignorePath = path.join(targetDir, '.npmignore');

  // Check if .gitignore exists and create it if not
  if (!existsSync(gitignorePath)) {
    // Use the exact content from the original plugin-starter/.gitignore
    const gitignoreContent = `dist/
node_modules/
`;

    try {
      await fs.writeFile(gitignorePath, gitignoreContent);
    } catch (error) {
      console.error(`Failed to create .gitignore: ${error.message}`);
    }
  }

  // Check if .npmignore exists and create it if not
  if (!existsSync(npmignorePath)) {
    // Use the exact content from the original plugin-starter/.npmignore
    const npmignoreContent = `.turbo
dist
node_modules
.env
*.env
.env.local`;

    try {
      await fs.writeFile(npmignorePath, npmignoreContent);
    } catch (error) {
      console.error(`Failed to create .npmignore: ${error.message}`);
    }
  }
}

/**
 * Initialize a new project, plugin, or agent.
 *
 * @param {Object} opts - Options for initialization.
 * @param {string} opts.dir - Installation directory.
 * @param {boolean} opts.yes - Skip confirmation.
 * @param {string} opts.type - Type to create (project, plugin, or agent).
 *
 * @returns {Promise<void>} Promise that resolves once the initialization process is complete.
 */
export const create = new Command()
  .name('create')
  .description('Initialize a new project, plugin, or agent')
  .option('-d, --dir <dir>', 'installation directory', '.')
  .option('-y, --yes', 'skip confirmation', false)
  .option('-t, --type <type>', 'type to create (project, plugin, or agent)', 'project')
  .argument('[name]', 'name for the project, plugin, or agent')
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

    // Display banner and continue with initialization
    await displayBanner();

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
              {
                title: 'Agent - Character definition file for an agent',
                value: 'agent',
              },
            ],
            initial: 0,
          });

          if (!type) {
            return;
          }
          projectType = type;
        }
      } else {
        // Validate the provided type if -t was used
        if (!['project', 'plugin', 'agent'].includes(projectType)) {
          console.error(`Invalid type: ${projectType}. Must be 'project', 'plugin', or 'agent'`);
          process.exit(1);
        }
      }

      // Now validate with zod after we've determined the type
      const options = initOptionsSchema.parse({
        ...initialOptions,
        type: projectType,
      });

      // Try to find the nearest .env file for database configuration
      const envPath = findNearestEnvFile();
      let postgresUrl: string | null = null;

      if (envPath) {
        require('dotenv').config({ path: envPath });
        postgresUrl = process.env.POSTGRES_URL || null;
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
            return;
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
          handleError(new Error(`Directory "${projectName}" is not empty`));
          return;
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

        await createIgnoreFiles(targetDir);

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
          `\nYour plugin is ready! Here's your development workflow:\n\n[1] Development\n   cd ${cdPath}\n   ${colors.cyan('elizaos dev')}                   # Start development with hot-reloading\n\n[2] Testing\n   ${colors.cyan('elizaos test')}                  # Run automated tests\n   ${colors.cyan('elizaos start')}                 # Test in a live agent environment\n\n[3] Publishing\n   ${colors.cyan('elizaos plugins publish --test')} # Check registry requirements\n   ${colors.cyan('elizaos plugins publish')}        # Submit to registry\n\n[?] Learn more: https://eliza.how/docs/cli/plugins`
        );
        process.stdout.write(`\u001B]1337;CurrentDir=${targetDir}\u0007`);
        return;
      } else if (options.type === 'agent') {
        // Agent character creation
        let characterName = projectName || 'MyAgent';

        // Start with the default Eliza character from the same source used by start.ts
        const agentTemplate = { ...elizaCharacter };

        // Update only the name property
        agentTemplate.name = characterName;

        // In messageExamples, replace "Eliza" with the new character name
        if (agentTemplate.messageExamples) {
          agentTemplate.messageExamples.forEach((conversation) => {
            conversation.forEach((message) => {
              if (message.name === 'Eliza') {
                message.name = characterName;
              }
            });
          });
        }

        // Set a simple filename - either the provided name or default
        let filename = characterName.endsWith('.json') ? characterName : `${characterName}.json`;

        // Make sure we're in the current directory
        const fullPath = path.join(process.cwd(), filename);

        // Write the character file
        await fs.writeFile(fullPath, JSON.stringify(agentTemplate, null, 2), 'utf8');

        console.log(`Agent character created successfully: ${filename}`);
        console.info(
          `\nYou can now use this agent with:\n  elizaos agent start --path ${filename}`
        );
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
          handleError(new Error('No database selected or provided'));
          return;
        }

        await copyTemplateUtil('project', targetDir, projectName);

        await createIgnoreFiles(targetDir);

        // Define project-specific .env file path, this will be created if it doesn't exist by downstream functions.
        const projectEnvFilePath = path.join(targetDir, '.env');

        await getElizaDirectories();

        if (database === 'pglite') {
          const projectPgliteDbDir = path.join(targetDir, '.pglite');
          await setupPgLite(projectPgliteDbDir, projectEnvFilePath);
          console.debug(
            `PGLite database will be stored in project directory: ${projectPgliteDbDir}`
          );
        } else if (database === 'postgres' && !postgresUrl) {
          // Store Postgres URL in the project's .env file.
          postgresUrl = await promptAndStorePostgresUrl(projectEnvFilePath);
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
      }
    } catch (error) {
      handleError(error);
    }
  });
