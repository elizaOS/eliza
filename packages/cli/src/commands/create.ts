import { character as elizaCharacter } from '@/src/characters/eliza';
import {
  buildProject,
  copyTemplate as copyTemplateUtil,
  displayBanner,
  ensureElizaDir,
  handleError,
  promptAndStorePostgresUrl,
  promptAndStoreOpenAIKey,
  promptAndStoreAnthropicKey,
  runBunCommand,
  setupPgLite,
} from '@/src/utils';
import { Command } from 'commander';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as clack from '@clack/prompts';
import colors from 'yoctocolors';
import { z } from 'zod';
import { logger } from '@elizaos/core';
import { join } from 'path';

/**
 * This module handles creating projects, plugins, agent characters, and TEE projects.
 *
 * Previously, plugin creation was handled by the "plugins create" command,
 * but that has been unified with project creation in this single command.
 * Users are now prompted to select which type they want to create.
 *
 * The workflow includes:
 * 1. Asking if the user wants to create a project, plugin, agent, or TEE project
 * 2. Getting the name and creating a directory or file
 * 3. Setting up proper templates and configurations
 * 4. Installing dependencies (for projects/plugins/TEE projects)
 * 5. Automatically changing directory to the created project/plugin/TEE project
 * 6. Showing the user the next steps
 */

const initOptionsSchema = z.object({
  dir: z.string().default('.'),
  yes: z.boolean().default(false),
  type: z.enum(['project', 'plugin', 'agent', 'tee']).default('project'),
});

type CreateOptions = z.infer<typeof initOptionsSchema>;

/**
 * Returns a list of available databases for project initialization without requiring external API calls.
 *
 * @returns A promise that resolves to an array of supported database names.
 */
async function getLocalAvailableDatabases(): Promise<string[]> {
  // Hard-coded list of available databases to avoid GitHub API calls
  return [
    'pglite',
    'postgres',
    // "pglite",
    // "supabase"
  ];
}

/**
 * Gets available AI models for selection during project creation.
 *
 * @returns {Array} Array of available AI model options
 */
function getAvailableAIModels() {
  return [
    {
      title: 'Local AI (free to use, no API key required)',
      value: 'local',
      description:
        'Use local AI models without external API requirements. Will download model to run locally.',
    },
    {
      title: 'OpenAI (ChatGPT)',
      value: 'openai',
      description: 'Use OpenAI models like GPT-4',
    },
    {
      title: 'Anthropic (Claude)',
      value: 'claude',
      description: 'Use Anthropic Claude models',
    },
  ];
}

/**
 * Gets available database options for selection during project creation.
 *
 * @returns {Array} Array of available database options
 */
function getAvailableDatabases() {
  return [
    {
      title: 'Pglite (Pglite) - Recommended for development',
      value: 'pglite',
      description:
        'Fast, file-based database. Perfect for development and single-user deployments.',
    },
    {
      title: 'PostgreSQL - Recommended for production',
      value: 'postgres',
      description:
        'Full-featured database with vector search. Best for production and multi-user systems.',
    },
  ];
}

/**
 * Sets up AI model configuration in the project's .env file based on user selection.
 *
 * @param {string} aiModel - The selected AI model ('local', 'openai', or 'claude')
 * @param {string} envFilePath - Path to the project's .env file
 * @param {boolean} isNonInteractive - Whether running in non-interactive mode
 * @returns {Promise<void>}
 */
async function setupAIModelConfig(
  aiModel: string,
  envFilePath: string,
  isNonInteractive = false
): Promise<void> {
  try {
    switch (aiModel) {
      case 'local': {
        console.info('[√] Using Local AI - no additional configuration needed');
        break;
      }

      case 'openai': {
        if (isNonInteractive) {
          // In non-interactive mode, just add placeholder
          let content = '';
          if (existsSync(envFilePath)) {
            content = await fs.readFile(envFilePath, 'utf8');
          }

          if (content && !content.endsWith('\n')) {
            content += '\n';
          }

          content += '\n# AI Model Configuration\n';
          content += '# OpenAI Configuration\n';
          content += 'OPENAI_API_KEY=your_openai_api_key_here\n';
          content += '# Get your API key from: https://platform.openai.com/api-keys\n';

          await fs.writeFile(envFilePath, content, 'utf8');
          console.info('[√] OpenAI placeholder configuration added to .env file');
        } else {
          // Interactive mode - prompt for OpenAI API key
          await promptAndStoreOpenAIKey(envFilePath);
        }
        break;
      }

      case 'claude': {
        if (isNonInteractive) {
          // In non-interactive mode, just add placeholder
          let content = '';
          if (existsSync(envFilePath)) {
            content = await fs.readFile(envFilePath, 'utf8');
          }

          if (content && !content.endsWith('\n')) {
            content += '\n';
          }

          content += '\n# AI Model Configuration\n';
          content += '# Anthropic API Configuration\n';
          content += 'ANTHROPIC_API_KEY=your_anthropic_api_key_here\n';
          content += '# Get your API key from: https://console.anthropic.com/\n';

          await fs.writeFile(envFilePath, content, 'utf8');
          console.info('[√] Anthropic API placeholder configuration added to .env file');
        } else {
          // Interactive mode - prompt for Anthropic API key
          await promptAndStoreAnthropicKey(envFilePath);
        }
        break;
      }

      default:
        console.warn(`Unknown AI model: ${aiModel}, skipping configuration`);
        return;
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to set up AI model configuration: ${errorMessage}`);
  }
}

/**
 * Installs dependencies for the specified target directory.
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
 * Prompts for database selection or uses default.
 */
async function selectDatabase(isYes: boolean): Promise<string> {
  const availableDatabases = getAvailableDatabases();

  if (isYes) {
    const database = 'pglite';
    console.info(`Using default database: ${database}`);
    return database;
  }

  const database = await clack.select({
    message: 'Select your database:',
    options: availableDatabases.map((choice, index) => ({
      value: choice.value,
      label: choice.title,
      hint: choice.description
    })),
    initialValue: availableDatabases[0]?.value
  });

  if (clack.isCancel(database)) {
    clack.cancel('Operation cancelled.');
    process.exit(0);
  }

  return database;
}

/**
 * Prompts for AI model selection or uses default.
 */
async function selectAIModel(isYes: boolean): Promise<string> {
  const availableAIModels = getAvailableAIModels();

  if (isYes) {
    const aiModel = 'local';
    console.info(`Using default AI model: ${aiModel}`);
    return aiModel;
  }

  const aiModel = await clack.select({
    message: 'Select your AI model:',
    options: availableAIModels.map((choice, index) => ({
      value: choice.value,
      label: choice.title,
      hint: choice.description
    })),
    initialValue: availableAIModels[0]?.value
  });

  if (clack.isCancel(aiModel)) {
    clack.cancel('Operation cancelled.');
    process.exit(0);
  }

  return aiModel;
}

/**
 * Creates necessary directories for a project.
 */
async function createProjectDirectories(targetDir: string): Promise<void> {
  if (!existsSync(targetDir)) {
    await fs.mkdir(targetDir, { recursive: true });
  }

  const srcDir = path.join(targetDir, 'src');
  if (!existsSync(srcDir)) {
    await fs.mkdir(srcDir);
  }

  await fs.mkdir(path.join(targetDir, 'knowledge'), { recursive: true });
}

/**
 * Sets up project environment (database, AI model, directories).
 */
async function setupProjectEnvironment(
  targetDir: string,
  database: string,
  aiModel: string,
  isYes: boolean
): Promise<void> {
  const projectEnvFilePath = path.join(targetDir, '.env');

  // Ensure proper directory creation in the new project
  const dirs = await ensureElizaDir(targetDir);
  logger.debug('Project directories set up:', dirs);

  if (database === 'pglite') {
    const projectPgliteDbDir = path.join(targetDir, '.elizadb');
    await setupPgLite(projectPgliteDbDir, projectEnvFilePath, targetDir);
    console.debug(`Pglite database will be stored in project directory: ${projectPgliteDbDir}`);
  } else if (database === 'postgres') {
    await promptAndStorePostgresUrl(projectEnvFilePath);
  }

  // Setup AI model configuration
  await setupAIModelConfig(aiModel, projectEnvFilePath, isYes);
}

/**
 * Validates and processes plugin name, ensuring proper prefix and format.
 */
function processPluginName(projectName: string): string {
  let processedName = projectName;

  if (!processedName.startsWith('plugin-')) {
    const prefixedName = `plugin-${processedName}`;
    console.info(
      `Note: Using "${prefixedName}" as the directory name to match plugin naming convention`
    );
    processedName = prefixedName;
  }

  // Validate plugin name format: plugin-[alphanumeric]
  const pluginNameRegex = /^plugin-[a-z0-9]+(-[a-z0-9]+)*$/;
  if (!pluginNameRegex.test(processedName)) {
    console.error(colors.red(`Error: Invalid plugin name "${processedName}".`));
    console.error('Plugin names must follow the format: plugin-[alphanumeric]');
    console.error('Examples: plugin-test, plugin-my-service, plugin-ai-tools');
    process.exit(1);
  }

  return processedName;
}

/**
 * Validates project name according to npm package naming rules.
 */
function validateProjectName(name: string, type: string): void {
  // Special case for creating a project in the current directory
  if (name === '.') {
    return;
  }

  // Check for spaces
  if (name.includes(' ')) {
    console.error(colors.red(`Error: Invalid ${type} name "${name}".`));
    console.error(`${type} names must follow npm package naming conventions:`);
    console.error('- Cannot contain spaces');
    console.error('- Must contain only lowercase letters, numbers, hyphens, or underscores');
    console.error('- Cannot start with a dot or underscore');
    process.exit(1);
  }

  // Basic npm package name validation (simplified version)
  // Only allow alphanumeric characters, hyphens, and underscores
  // Don't start with a dot or an underscore
  // Don't contain uppercase letters (for consistency)
  const validNameRegex = /^[a-z0-9][-a-z0-9._]*$/;
  if (!validNameRegex.test(name)) {
    console.error(colors.red(`Error: Invalid ${type} name "${name}".`));
    console.error(`${type} names must follow npm package naming conventions:`);
    console.error('- Cannot contain spaces');
    console.error('- Must contain only lowercase letters, numbers, hyphens, or underscores');
    console.error('- Cannot start with a dot or underscore');
    process.exit(1);
  }
}

/**
 * Checks if target directory exists and is empty.
 */
async function validateTargetDirectory(targetDir: string, projectName: string): Promise<void> {
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
      throw new Error(`Directory "${projectName}" is not empty`);
    }
    // Directory exists but is empty - this is fine
    console.info(`Note: Directory "${projectName}" already exists but is empty. Continuing...`);
  }
}

/**
 * Handles plugin creation.
 */
async function createPlugin(
  options: CreateOptions,
  projectName: string,
  targetDir: string
): Promise<void> {
  const processedName = processPluginName(projectName);
  const finalTargetDir = path.join(path.dirname(targetDir), processedName);

  await validateTargetDirectory(finalTargetDir, processedName);

  // Create directory if it doesn't exist
  if (!existsSync(finalTargetDir)) {
    await fs.mkdir(finalTargetDir, { recursive: true });
  }

  const pluginName = processedName.startsWith('@elizaos/plugin-')
    ? processedName
    : `@elizaos/plugin-${processedName.replace('plugin-', '')}`;

  await copyTemplateUtil('plugin', finalTargetDir, pluginName);

  console.info('Installing dependencies...');
  try {
    await runBunCommand(['install', '--no-optional'], finalTargetDir);
    console.log('Dependencies installed successfully!');

    // Skip building in test environments to avoid tsup dependency issues
    if (process.env.ELIZA_NONINTERACTIVE === '1' || process.env.ELIZA_NONINTERACTIVE === 'true') {
      console.log('Skipping build in non-interactive mode');
    } else {
      await buildProject(finalTargetDir, true);
    }
  } catch (_error) {
    console.warn(
      "Failed to install dependencies automatically. Please run 'bun install' manually."
    );
  }

  console.log('Plugin initialized successfully!');
  const cdPath = options.dir === '.' ? processedName : path.relative(process.cwd(), finalTargetDir);
  console.info(
    `\nYour plugin is ready! Here's your development workflow:\n\n[1] Development\n   cd ${cdPath}\n   ${colors.cyan('elizaos dev')}                   # Start development with hot-reloading\n\n[2] Testing\n   ${colors.cyan('elizaos test')}                  # Run automated tests\n   ${colors.cyan('elizaos start')}                 # Test in a live agent environment\n\n[3] Publishing\n   ${colors.cyan('elizaos publish --test')}        # Check registry requirements\n   ${colors.cyan('elizaos publish')}               # Submit to registry\n\n[?] Learn more: https://eliza.how/docs/cli/plugins`
  );
  process.stdout.write(`\u001B]1337;CurrentDir=${finalTargetDir}\u0007`);
}

/**
 * Handles agent creation.
 */
async function createAgent(projectName: string): Promise<void> {
  const characterName = projectName || 'MyAgent';

  // Start with the default Eliza character from the same source used by start.ts
  const agentTemplate = { ...elizaCharacter };

  // Update only the name property
  agentTemplate.name = characterName;

  // In messageExamples, replace "Eliza" with the new character name
  if (agentTemplate.messageExamples) {
    for (const conversation of agentTemplate.messageExamples) {
      for (const message of conversation) {
        if (message.name === 'Eliza') {
          message.name = characterName;
        }
      }
    }
  }

  // Set a simple filename - either the provided name or default
  const filename = characterName.endsWith('.json') ? characterName : `${characterName}.json`;

  // Make sure we're in the current directory
  const fullPath = path.join(process.cwd(), filename);

  // Write the character file
  await fs.writeFile(fullPath, JSON.stringify(agentTemplate, null, 2), 'utf8');

  console.log(`Agent character created successfully: ${filename}`);
  console.info(`\nYou can now use this agent with:\n  elizaos agent start --path ${filename}`);
}

/**
 * Handles TEE project creation.
 */
async function createTEEProject(
  options: CreateOptions,
  projectName: string,
  targetDir: string
): Promise<void> {
  console.info('Creating TEE-enabled project with TEE capabilities...');

  await validateTargetDirectory(targetDir, projectName);
  await createProjectDirectories(targetDir);

  const database = await selectDatabase(options.yes);
  const aiModel = await selectAIModel(options.yes);

  await copyTemplateUtil('project-tee-starter', targetDir, projectName);
  await setupProjectEnvironment(targetDir, database, aiModel, options.yes);
  await installDependencies(targetDir);

  // Skip building in test environments to avoid tsup dependency issues
  if (process.env.ELIZA_NONINTERACTIVE === '1' || process.env.ELIZA_NONINTERACTIVE === 'true') {
    console.log('Skipping build in non-interactive mode');
  } else {
    await buildProject(targetDir);
  }

  console.log('TEE project initialized successfully!');
  const cdPath = options.dir === '.' ? projectName : path.relative(process.cwd(), targetDir);
  console.info(
    `\nYour TEE project is ready! Here's what you can do next:\n1. \`cd ${cdPath}\` to change into your project directory\n2. Run \`elizaos start\` to start your project\n3. Visit \`http://localhost:3000\` (or your custom port) to view your project in the browser\n4. Use \`elizaos tee phala\` commands for TEE deployment`
  );
  process.stdout.write(`\u001B]1337;CurrentDir=${targetDir}\u0007`);
}

/**
 * Handles regular project creation.
 */
async function createProject(
  options: CreateOptions,
  projectName: string,
  targetDir: string
): Promise<void> {
  await validateTargetDirectory(targetDir, projectName);
  await createProjectDirectories(targetDir);

  const database = await selectDatabase(options.yes);
  const aiModel = await selectAIModel(options.yes);

  await copyTemplateUtil('project-starter', targetDir, projectName);
  await setupProjectEnvironment(targetDir, database, aiModel, options.yes);
  await installDependencies(targetDir);

  // Skip building in test environments to avoid tsup dependency issues
  if (process.env.ELIZA_NONINTERACTIVE === '1' || process.env.ELIZA_NONINTERACTIVE === 'true') {
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

/**
 * Initialize a new project, plugin, agent, or TEE project.
 */
export const create = new Command()
  .name('create')
  .description('Initialize a new project, plugin, agent, or TEE project')
  .option('-d, --dir <dir>', 'installation directory', '.')
  .option('-y, --yes', 'skip confirmation', false)
  .option('-t, --type <type>', 'type to create (project, plugin, agent, or tee)', 'project')
  .argument('[name]', 'name for the project, plugin, agent, or TEE project')
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
        } else {
          // Prompt the user if -y is not used
          const type = await clack.select({
            message: 'What would you like to create?',
            options: [
              { value: 'project', label: 'Project - Contains agents and plugins' },
              {
                value: 'plugin',
                label: 'Plugin - Can be added to the registry and installed by others',
              },
              {
                value: 'agent',
                label: 'Agent - Character definition file for an agent',
              },
              {
                value: 'tee',
                label: 'TEE - Trusted Execution Environment project',
              },
            ],
            initialValue: 'project',
          });

          if (clack.isCancel(type)) {
            clack.cancel('Operation cancelled.');
            process.exit(0);
          }
          projectType = type;
        }
      } else {
        // Validate the provided type if -t was used
        if (!['project', 'plugin', 'agent', 'tee'].includes(projectType)) {
          console.error(
            `Invalid type: ${projectType}. Must be 'project', 'plugin', 'agent', or 'tee'`
          );
          process.exit(1);
        }
      }

      // Now validate with zod after we've determined the type
      const options = initOptionsSchema.parse({
        ...initialOptions,
        type: projectType,
      });

      // Prompt for project/plugin name if not provided
      let projectName = name;
      if (!projectName) {
        if (options.yes) {
          projectName = options.type === 'plugin' ? 'myplugin' : 'myproject';
          console.info(`Using default name: ${projectName}`);
        } else {
          const nameResponse = await clack.text({
            message: `What would you like to name your ${options.type}?`,
            validate: (value) => value.length > 0 ? undefined : `${options.type} name is required`,
          });

          if (clack.isCancel(nameResponse)) {
            clack.cancel('Operation cancelled.');
            process.exit(0);
          }
          projectName = nameResponse;
        }
      }

      // Validate project name according to npm package naming rules
      validateProjectName(projectName, options.type);

      const targetDir = path.join(options.dir === '.' ? process.cwd() : options.dir, projectName);

      // Route to appropriate handler based on type
      if (options.type === 'plugin') {
        await createPlugin(options, projectName, targetDir);
      } else if (options.type === 'agent') {
        await createAgent(projectName);
      } else if (options.type === 'tee') {
        await createTEEProject(options, projectName, targetDir);
      } else if (options.type === 'project') {
        await createProject(options, projectName, targetDir);
      } else {
        // This should never happen due to zod validation, but just in case
        console.error(`Unknown type: ${options.type}`);
        process.exit(1);
      }
    } catch (error) {
      handleError(error);
    }
  });
