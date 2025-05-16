import { handleError, UserEnvironment } from '@/src/utils';
import { stringToUuid } from '@elizaos/core';
import { Command } from 'commander';
import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import prompts from 'prompts';
import { rimraf } from 'rimraf';
import colors from 'yoctocolors';

// Path to store the custom env path setting in the config.json file
const CONFIG_FILE = path.join(os.homedir(), '.eliza', 'config.json');

/**
 * Get the custom env path if one has been set
 * @returns The custom env path or null if not set
 */
async function getCustomEnvPath(): Promise<string | null> {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return null;
    }

    const content = await fs.readFile(CONFIG_FILE, 'utf-8');
    // Handle empty or malformed file
    if (!content) return null;
    const config = JSON.parse(content);
    return config.envPath || null;
  } catch (error) {
    console.error(`Error reading custom env path from ${CONFIG_FILE}: ${error.message}`);
    return null;
  }
}

/**
 * Save a custom env path to the config file
 * @param customPath The path to save
 */
async function saveCustomEnvPath(customPath: string): Promise<void> {
  try {
    const dir = path.dirname(CONFIG_FILE);
    if (!existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
    }

    // Preserve existing config if it exists
    let config = {};
    if (existsSync(CONFIG_FILE)) {
      try {
        const content = await fs.readFile(CONFIG_FILE, 'utf-8');
        config = JSON.parse(content);
      } catch (e) {
        console.warn(`Could not parse existing config file: ${e.message}`);
      }
    }

    // Update the config with the new env path
    config = {
      ...config,
      envPath: customPath,
    };

    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`Custom environment path set to: ${customPath}`);
  } catch (error) {
    console.error(`Error saving custom env path: ${error.message}`);
  }
}

/**
 * Get the path to the global .env file in the user's home directory or custom location
 * @returns The path to the global .env file
 */
export async function getGlobalEnvPath(): Promise<string> {
  const customPath = await getCustomEnvPath();
  if (customPath) {
    // Check if the file pointed to by customPath actually exists
    if (!existsSync(customPath)) {
      console.warn(
        `Custom env path specified in config (${customPath}) does not exist. Falling back to default path.`
      );
      // Fallback logic (same as below)
      const homeDir = os.homedir();
      const elizaDir = path.join(homeDir, '.eliza');
      if (!existsSync(elizaDir)) {
        try {
          await fs.mkdir(elizaDir, { recursive: true });
          console.warn(`Default config directory ${elizaDir} did not exist. Created it.`);
        } catch (mkdirError) {
          console.error(
            `Failed to create default config directory ${elizaDir}: ${mkdirError.message}`
          );
          // If we can't create the default dir, return the problematic custom path anyway?
          // Or throw an error? Let's return the default path for now.
        }
      }
      return path.join(elizaDir, '.env');
    }
    // Custom path exists, return it
    return customPath;
  }

  // No custom path set, use default
  const homeDir = os.homedir();
  const elizaDir = path.join(homeDir, '.eliza');
  // Ensure the default directory exists
  if (!existsSync(elizaDir)) {
    try {
      await fs.mkdir(elizaDir, { recursive: true });
      console.warn(`Default config directory ${elizaDir} did not exist. Created it.`);
    } catch (mkdirError) {
      console.error(`Failed to create default config directory ${elizaDir}: ${mkdirError.message}`);
      // Decide on error handling - maybe throw here?
      // For now, proceed to return the path, expecting write operations might fail later.
    }
  }
  return path.join(elizaDir, '.env');
}

/**
 * Get the path to the local .env file in the current directory
 * @returns The path to the local .env file or null if not found
 */
function getLocalEnvPath(): string | null {
  const localEnvPath = path.join(process.cwd(), '.env');
  return existsSync(localEnvPath) ? localEnvPath : null;
}

/**
 * Parse an .env file and return the key-value pairs
 * @param filePath Path to the .env file
 * @returns Object containing the key-value pairs
 */
export async function parseEnvFile(filePath: string): Promise<Record<string, string>> {
  try {
    if (!existsSync(filePath)) {
      // Log a warning instead of just returning {} silently
      console.warn(`Attempted to parse non-existent env file: ${filePath}`);
      return {};
    }

    const content = await fs.readFile(filePath, 'utf-8');
    // Handle empty file case gracefully
    if (content.trim() === '') {
      return {};
    }
    return dotenv.parse(content);
  } catch (error) {
    console.error(`Error parsing .env file at ${filePath}: ${error.message}`);
    return {};
  }
}

/**
 * Write key-value pairs to an .env file
 * @param filePath Path to the .env file
 * @param envVars Object containing the key-value pairs
 */
async function writeEnvFile(filePath: string, envVars: Record<string, string>): Promise<void> {
  try {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
    }

    const content = Object.entries(envVars)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    await fs.writeFile(filePath, content);
    console.log(`Environment variables updated at ${filePath}`);
  } catch (error) {
    console.error(`Error writing .env file at ${filePath}: ${error.message}`);
  }
}

/**
 * Displays system information and lists environment variables from global and local `.env` files.
 *
 * Prints platform, architecture, CLI version, and package manager details, followed by environment variables from the global and local scopes with sensitive values masked. Indicates if no variables are set and provides a link to the web UI for editing.
 */
async function listEnvVars(): Promise<void> {
  const envInfo = await UserEnvironment.getInstanceInfo();
  const globalEnvPath = await getGlobalEnvPath();
  const localEnvPath = getLocalEnvPath();

  // Display system information
  console.info(colors.bold('\nSystem Information:'));
  console.info(`  Platform: ${colors.cyan(envInfo.os.platform)} (${envInfo.os.release})`);
  console.info(`  Architecture: ${colors.cyan(envInfo.os.arch)}`);
  console.info(`  CLI Version: ${colors.cyan(envInfo.cli.version)}`);
  console.info(
    `  Package Manager: ${colors.cyan(envInfo.packageManager.name)}${envInfo.packageManager.version ? ` v${envInfo.packageManager.version}` : ''}`
  );

  console.info(colors.bold('\nGlobal Environment Variables:'));
  console.info(`Path: ${globalEnvPath}`);

  if (!existsSync(globalEnvPath)) {
    console.info('  No global environment variables set');
  } else {
    const globalEnvVars = await parseEnvFile(globalEnvPath);
    for (const [key, value] of Object.entries(globalEnvVars)) {
      console.info(`  ${colors.green(key)}: ${maskedValue(value)}`);
    }
  }

  // Always display local environment section regardless of whether a file exists
  console.info(colors.bold('\nLocal Environment Variables:'));
  const localEnvFilePath = path.join(process.cwd(), '.env');
  console.info(`Path: ${localEnvFilePath}`);

  if (!existsSync(localEnvFilePath)) {
    // No local .env file exists, provide guidance to the user
    console.info(colors.yellow('  No local .env file found'));

    // Check if .env.example exists and suggest copying it as a starting point
    const exampleEnvPath = path.join(process.cwd(), '.env.example');
    if (existsSync(exampleEnvPath)) {
      console.info(colors.red('  ✖ Missing .env file. Create one with:'));
      console.info(`     ${colors.bold(colors.green('cp .env.example .env'))}`);
    } else {
      console.info(
        colors.red(
          '  ✖ Missing .env file. Create one in your project directory to set local environment variables.'
        )
      );
    }
  } else {
    // .env file exists, parse and display its contents
    const localEnvVars = await parseEnvFile(localEnvFilePath);
    if (Object.keys(localEnvVars).length === 0) {
      console.info('  No local environment variables set');
    } else {
      for (const [key, value] of Object.entries(localEnvVars)) {
        console.info(`  ${colors.green(key)}: ${maskedValue(value)}`);
      }
    }
  }

  console.info('\n');
  console.info(
    colors.cyan(
      'You can also edit environment variables in the web UI: http://localhost:3000/settings'
    )
  );
}

/**
 * Mask sensitive values in environment variables
 * @param value The value to mask
 * @returns The masked value
 */
function maskedValue(value: string): string {
  if (!value) return '';

  // If the value looks like a token/API key (longer than 20 chars, no spaces), mask it
  if (value.length > 20 && !value.includes(' ')) {
    return `${value.substring(0, 4)}...${value.substring(value.length - 4)}`;
  }

  return value;
}

/**
 * Edit environment variables
 * @param scope Whether to edit global or local environment variables
 * @returns A boolean indicating whether the user wants to go back to the main menu
 */
async function editEnvVars(
  scope: 'global' | 'local',
  fromMainMenu = false,
  yes = false
): Promise<boolean> {
  const envPath = scope === 'global' ? await getGlobalEnvPath() : getLocalEnvPath();

  if (scope === 'local' && !envPath) {
    let createLocal = true;
    if (!yes) {
      const resp = await prompts({
        type: 'confirm',
        name: 'createLocal',
        message: 'No local .env file found. Create one?',
        initial: true,
      });
      createLocal = resp.createLocal;
    }
    if (!createLocal) {
      return false;
    }
    await fs.writeFile('.env', '');
  }

  const envVars = await parseEnvFile(envPath);

  // List current variables first
  console.info(colors.bold(`\nCurrent ${scope} environment variables:`));
  if (Object.keys(envVars).length === 0) {
    console.info(`  No ${scope} environment variables set`);

    // If no variables exist, offer to add new ones
    const { addNew } = await prompts({
      type: 'confirm',
      name: 'addNew',
      message: 'Would you like to add a new environment variable?',
      initial: true,
    });

    if (addNew) {
      await addNewVariable(envPath, envVars);
    }

    return fromMainMenu; // Return to main menu if we came from there
  }

  // Keep looping until the user chooses to exit
  let exit = false;
  let returnToMain = false;

  while (!exit) {
    // Create menu choices from the environment variables
    const entries = Object.entries(envVars);
    const choices = [
      ...entries.map(([key, value]) => ({
        title: `${key}: ${maskedValue(value)}`,
        value: key,
      })),
      { title: 'Add new variable', value: 'add_new' },
      fromMainMenu
        ? { title: 'Back to main menu', value: 'back_to_main' }
        : { title: 'Exit', value: 'exit' },
    ];

    // Prompt user to select a variable or action
    const { selection } = await prompts({
      type: 'select',
      name: 'selection',
      message: 'Select a variable to edit or an action:',
      choices,
    });

    if (!selection) {
      // If user cancels (Ctrl+C), go back to main menu if we came from there
      return fromMainMenu;
    }

    if (selection === 'exit' || selection === 'back_to_main') {
      exit = true;
      returnToMain = selection === 'back_to_main';
      continue;
    }

    if (selection === 'add_new') {
      await addNewVariable(envPath, envVars);
      continue;
    }

    // User selected a variable, prompt for action
    const { action } = await prompts({
      type: 'select',
      name: 'action',
      message: `What would you like to do with ${selection}?`,
      choices: [
        { title: 'Edit', value: 'edit' },
        { title: 'Delete', value: 'delete' },
        { title: 'Back', value: 'back' },
      ],
    });

    if (!action || action === 'back') {
      continue;
    }

    if (action === 'edit') {
      const { value } = await prompts({
        type: 'text',
        name: 'value',
        message: `Enter the new value for ${selection}:`,
        initial: envVars[selection],
      });

      if (value !== undefined) {
        envVars[selection] = value;
        await writeEnvFile(envPath, envVars);
        console.log(`Updated ${scope} environment variable: ${selection}`);
      }
    } else if (action === 'delete') {
      let confirm = true;
      if (!yes) {
        const resp = await prompts({
          type: 'confirm',
          name: 'confirm',
          message: `Are you sure you want to delete ${selection}?`,
          initial: false,
        });
        confirm = resp.confirm;
      }
      if (confirm) {
        delete envVars[selection];
        await writeEnvFile(envPath, envVars);
        console.log(`Removed ${scope} environment variable: ${selection}`);
      }
    }
  }

  return returnToMain && fromMainMenu;
}

/**
 * Helper function to add a new environment variable
 * @param envPath Path to the .env file
 * @param envVars Current environment variables
 */
async function addNewVariable(envPath: string, envVars: Record<string, string>): Promise<void> {
  const { key } = await prompts({
    type: 'text',
    name: 'key',
    message: 'Enter the variable name:',
    validate: (value) => (value.trim() !== '' ? true : 'Variable name cannot be empty'),
  });

  if (!key) return;

  const { value } = await prompts({
    type: 'text',
    name: 'value',
    message: `Enter the value for ${key}:`,
  });

  if (value !== undefined) {
    envVars[key] = value;
    await writeEnvFile(envPath, envVars);
    console.log(`Added environment variable: ${key}`);
  }
}

/**
 * Helper function to reset an environment file by keeping keys but clearing values
 * @param filePath Path to the environment file
 * @returns A boolean indicating success/failure
 */
async function resetEnvFile(filePath: string): Promise<boolean> {
  try {
    if (!existsSync(filePath)) {
      return false;
    }

    const envVars = await parseEnvFile(filePath);
    if (Object.keys(envVars).length === 0) {
      return false; // No variables to reset
    }

    const resetVars = Object.keys(envVars).reduce(
      (acc, key) => {
        acc[key] = '';
        return acc;
      },
      {} as Record<string, string>
    );

    await writeEnvFile(filePath, resetVars);
    return true;
  } catch (error) {
    console.error(`Error resetting environment file at ${filePath}: ${error.message}`);
    return false;
  }
}

// Reset operation types and helper functions
type ResetTarget = 'globalEnv' | 'localEnv' | 'cache' | 'globalDb' | 'localDb';
type ResetAction = 'reset' | 'deleted' | 'skipped' | 'warning';

interface ResetItem {
  title: string;
  value: ResetTarget;
  description?: string;
  selected?: boolean;
}

/**
 * Delete a directory with error handling
 * @param dir Directory path to delete
 * @param actions Action log collection to update
 * @param label Description label for this operation
 * @returns Success or failure
 */
async function safeDeleteDirectory(
  dir: string,
  actions: Record<string, string[]>,
  label: string
): Promise<boolean> {
  if (!existsSync(dir)) {
    actions.skipped.push(`${label} (not found)`);
    return false;
  }

  try {
    await rimraf(dir);
    if (!existsSync(dir)) {
      actions.deleted.push(label);
      return true;
    } else {
      actions.warnings.push(`Failed to delete ${label.toLowerCase()}`);
      return false;
    }
  } catch (error) {
    actions.warnings.push(`Failed to delete ${label.toLowerCase()}: ${error.message}`);
    return false;
  }
}

/**
 * Reset environment variables and selected folders
 */
async function resetEnv(yes = false): Promise<void> {
  // Get all relevant paths
  const homeDir = os.homedir();
  const elizaDir = path.join(homeDir, '.eliza');
  const globalEnvPath = await getGlobalEnvPath();
  const cacheDir = path.join(elizaDir, 'cache');
  const projectUuid = stringToUuid(process.cwd());
  const globalDbDir = path.join(elizaDir, 'projects', projectUuid, 'db');
  const globalPgliteDir = path.join(elizaDir, 'projects', projectUuid, 'pglite');
  const localEnvPath = path.join(process.cwd(), '.env');
  const localDbDir = path.join(process.cwd(), 'elizadb');

  // Check if external Postgres is in use
  let usingExternalPostgres = false;
  try {
    const globalEnvVars = await parseEnvFile(globalEnvPath);
    const localEnvVars = await parseEnvFile(localEnvPath);
    usingExternalPostgres =
      (globalEnvVars.POSTGRES_URL && globalEnvVars.POSTGRES_URL.trim() !== '') ||
      (localEnvVars.POSTGRES_URL && localEnvVars.POSTGRES_URL.trim() !== '');
  } catch (error) {
    // Ignore errors
  }

  // Create reset item options
  const resetItems: ResetItem[] = [
    {
      title: 'Global environment variables',
      value: 'globalEnv',
      description: 'Reset values in global .env file',
      selected: false,
    },
    {
      title: 'Local environment variables',
      value: 'localEnv',
      description: 'Reset values in local .env file',
      selected: false,
    },
    {
      title: 'Cache folder',
      value: 'cache',
      description: existsSync(cacheDir)
        ? 'Delete the cache folder'
        : 'Cache folder not found, nothing to delete',
      selected: false,
    },
    {
      title: 'Global database files',
      value: 'globalDb',
      description:
        !existsSync(globalDbDir) && !existsSync(globalPgliteDir)
          ? 'Global database files not found, nothing to delete'
          : usingExternalPostgres
            ? 'WARNING: External PostgreSQL database detected - only local files will be removed'
            : 'Delete global database files',
      selected: false,
    },
    {
      title: 'Local database files',
      value: 'localDb',
      description: existsSync(localDbDir)
        ? 'Delete local database files'
        : 'Local database folder not found, nothing to delete',
      selected: false,
    },
  ];

  // Get selected items (from options or defaults)
  let selectedValues: ResetTarget[] = [];

  if (yes) {
    // Use default selections if using --yes flag
    selectedValues = resetItems.filter((item) => item.selected).map((item) => item.value);
  } else {
    // Prompt user to select items with styling matching interactive mode
    const { selections } = await prompts({
      type: 'multiselect',
      name: 'selections',
      message: colors.cyan(colors.bold('Select items to reset:')),
      choices: resetItems,
      instructions: false,
      hint: '- Space to select, Enter to confirm',
      min: 1,
    });

    if (!selections || selections.length === 0) {
      console.log('No items selected. Reset cancelled.');
      return;
    }

    selectedValues = selections;

    // Show selected items
    console.log('\nYou selected:');
    for (const value of selectedValues) {
      const item = resetItems.find((item) => item.value === value);
      console.log(`  • ${item.title}`);
    }

    // Final confirmation
    const { confirm } = await prompts({
      type: 'confirm',
      name: 'confirm',
      message: 'Are you sure you want to reset the selected items?',
      initial: false,
    });

    if (!confirm) {
      console.log('Reset cancelled.');
      return;
    }
  }

  // Track reset results
  const actions: Record<ResetAction, string[]> = {
    reset: [],
    deleted: [],
    skipped: [],
    warning: [],
  };

  // Process each selected item
  for (const target of selectedValues) {
    switch (target) {
      case 'globalEnv':
        if (await resetEnvFile(globalEnvPath)) {
          actions.reset.push('Global environment variables');
        } else {
          actions.skipped.push('Global environment variables (no file or empty)');
        }
        break;

      case 'localEnv':
        if (await resetEnvFile(localEnvPath)) {
          actions.reset.push('Local environment variables');
        } else {
          actions.skipped.push('Local environment variables (no file or empty)');
        }
        break;

      case 'cache':
        await safeDeleteDirectory(cacheDir, actions, 'Cache folder');
        break;

      case 'globalDb':
        if (usingExternalPostgres) {
          actions.warning.push(
            'External PostgreSQL database detected. Database data cannot be reset but local database cache files will be removed.'
          );
        }

        let anyGlobalDbDeleted = false;

        // Try deleting db dir
        if (existsSync(globalDbDir)) {
          if (await safeDeleteDirectory(globalDbDir, actions, 'Global database folder')) {
            anyGlobalDbDeleted = true;
          }
        }

        // Try deleting PGLite dir
        if (existsSync(globalPgliteDir)) {
          if (
            await safeDeleteDirectory(globalPgliteDir, actions, 'Global PGLite database folder')
          ) {
            anyGlobalDbDeleted = true;
          }
        }

        // If neither existed and nothing was deleted
        if (!anyGlobalDbDeleted && !existsSync(globalDbDir) && !existsSync(globalPgliteDir)) {
          actions.skipped.push('Global database files (not found)');
        }
        break;

      case 'localDb':
        await safeDeleteDirectory(localDbDir, actions, 'Local database folder');
        break;
    }
  }

  // Print summary report
  console.log(colors.bold('\nReset Summary:'));

  if (actions.reset.length > 0) {
    console.log(colors.green('  Values Cleared:'));
    actions.reset.forEach((item) => console.log(`    • ${item}`));
  }

  if (actions.deleted.length > 0) {
    console.log(colors.green('  Deleted:'));
    actions.deleted.forEach((item) => console.log(`    • ${item}`));
  }

  if (actions.skipped.length > 0) {
    console.log(colors.yellow('  Skipped:'));
    actions.skipped.forEach((item) => console.log(`    • ${item}`));
  }

  if (actions.warning.length > 0) {
    console.log(colors.red('  Warnings:'));
    actions.warning.forEach((item) => console.log(`    • ${item}`));
  }

  console.log(colors.bold('\nEnvironment reset complete'));
}

/**
 * Set a custom path for the global .env file
 * @param customPath The custom path to use
 * @param autoConfirm Automatically confirm prompts
 */
async function setEnvPath(customPath: string, autoConfirm = false): Promise<void> {
  // Expand tilde (~) in the path if present
  if (customPath.startsWith('~')) {
    customPath = path.join(os.homedir(), customPath.substring(1));
  }

  // Validate the path
  const resolvedPath = path.resolve(customPath);
  const isDirectory = existsSync(resolvedPath) && (await fs.stat(resolvedPath)).isDirectory();

  let finalPath = resolvedPath;
  if (isDirectory) {
    finalPath = path.join(resolvedPath, '.env');
    console.info(`Path is a directory. Will use ${finalPath} for environment variables.`);
  }

  // Check if parent directory exists
  const parentDir = path.dirname(finalPath);
  if (!existsSync(parentDir)) {
    let createDir = autoConfirm;
    if (!autoConfirm) {
      const response = await prompts({
        type: 'confirm',
        name: 'createDir',
        message: `Directory ${parentDir} does not exist. Create it?`,
        initial: true,
      });
      createDir = response.createDir;
    }

    if (createDir) {
      try {
        await fs.mkdir(parentDir, { recursive: true });
        console.log(`Created directory: ${parentDir}`);
      } catch (error) {
        console.error(`Failed to create directory: ${error.message}`);
        console.info('Custom path not set');
        return;
      }
    } else {
      console.info('Custom path not set');
      return;
    }
  }

  // If the file doesn't exist, create an empty one
  if (!existsSync(finalPath)) {
    let createFile = autoConfirm;
    if (!autoConfirm) {
      const response = await prompts({
        type: 'confirm',
        name: 'createFile',
        message: `Environment file doesn't exist at ${finalPath}. Create an empty one?`,
        initial: true,
      });
      createFile = response.createFile;
    }

    if (createFile) {
      await writeEnvFile(finalPath, {});
      console.log(`Created empty .env file at ${finalPath}`);
    } else if (!autoConfirm) {
      // If user explicitly said no (and not autoConfirm), don't save the path
      console.info('Custom path not set as file creation was declined.');
      return;
    }
  }

  await saveCustomEnvPath(finalPath);
}

// Create command for managing environment variables
export const env = new Command()
  .name('env')
  .description('Manage environment variables and secrets');

// List subcommand
env
  .command('list')
  .description('List all environment variables')
  .option('--system', 'List only system information')
  .option('--global', 'List only global environment variables')
  .option('--local', 'List only local environment variables')
  .action(async (options: { global?: boolean; local?: boolean; system?: boolean }) => {
    try {
      if (options.system) {
        // Show only system information
        const envInfo = await UserEnvironment.getInstanceInfo();
        console.info(colors.bold('\nSystem Information:'));
        console.info(`  Platform: ${colors.cyan(envInfo.os.platform)} (${envInfo.os.release})`);
        console.info(`  Architecture: ${colors.cyan(envInfo.os.arch)}`);
        console.info(`  CLI Version: ${colors.cyan(envInfo.cli.version)}`);
        console.info(
          `  Package Manager: ${colors.cyan(envInfo.packageManager.name)}${envInfo.packageManager.version ? ` v${envInfo.packageManager.version}` : ''}`
        );
      } else if (options.local) {
        const localEnvPath = getLocalEnvPath();
        if (!localEnvPath) {
          console.error('No local .env file found in the current directory');
          process.exit(1); // Exit with error code to make the test pass
        }
        const localEnvVars = await parseEnvFile(localEnvPath);
        console.info(colors.bold('\nLocal environment variables (.env):'));
        if (Object.keys(localEnvVars).length === 0) {
          console.info('  No local environment variables set');
        } else {
          for (const [key, value] of Object.entries(localEnvVars)) {
            console.info(`  ${colors.green(key)}: ${maskedValue(value)}`);
          }
        }
      } else if (options.global) {
        const globalEnvPath = await getGlobalEnvPath();
        const globalEnvVars = await parseEnvFile(globalEnvPath);
        const customPath = await getCustomEnvPath();
        const globalEnvLabel = customPath
          ? `Global environment variables (custom path: ${customPath})`
          : 'Global environment variables (.eliza/.env)';

        console.info(colors.bold(`\n${globalEnvLabel}:`));
        if (Object.keys(globalEnvVars).length === 0) {
          console.info('  No global environment variables set');
        } else {
          for (const [key, value] of Object.entries(globalEnvVars)) {
            console.info(`  ${colors.green(key)}: ${maskedValue(value)}`);
          }
        }
      } else {
        await listEnvVars();
      }
    } catch (error) {
      handleError(error);
    }
  });

// Edit global subcommand
env
  .command('edit-global')
  .description('Edit global environment variables')
  .option('-y, --yes', 'Automatically confirm prompts')
  .action(async (options) => {
    try {
      await editEnvVars('global', false, options.yes);
    } catch (error) {
      handleError(error);
    }
  });

// Edit local subcommand
env
  .command('edit-local')
  .description('Edit local environment variables')
  .option('-y, --yes', 'Automatically confirm prompts')
  .action(async (options) => {
    try {
      await editEnvVars('local', false, options.yes);
    } catch (error) {
      handleError(error);
    }
  });

// Reset subcommand
env
  .command('reset')
  .description(
    'Reset environment variables and clean up database/cache files (interactive selection)'
  )
  .option('-y, --yes', 'Automatically reset using default selections')
  .action(async (options: { yes?: boolean }) => {
    try {
      await resetEnv(options.yes);
    } catch (error) {
      handleError(error);
    }
  });

// Set custom path subcommand
env
  .command('set-path <path>')
  .description('Set a custom path for the global environment file')
  .option('-y, --yes', 'Automatically create directory and file if they do not exist')
  .action(async (customPath: string, options: { yes?: boolean }) => {
    try {
      await setEnvPath(customPath, options.yes);
    } catch (error) {
      handleError(error);
    }
  });

// Interactive mode
env
  .command('interactive')
  .description('Interactive environment variable management')
  .option('-y, --yes', 'Automatically confirm prompts')
  .action(async (options) => {
    try {
      await showMainMenu(options.yes);
    } catch (error) {
      handleError(error);
    }
  });

// Default command (show help if no subcommand provided)
env.action(() => {
  // Show available subcommands
  console.log(colors.bold('\nEliza Environment Variable Manager'));
  console.log('\nAvailable commands:');
  console.log('  list                  List all environment variables');
  console.log('  edit-global           Edit global environment variables');
  console.log('  edit-local            Edit local environment variables');
  console.log('  set-path <path>       Set a custom path for the global environment file');
  console.log(
    '  reset                 Reset environment variables and clean up database/cache files (interactive selection)'
  );
  console.log('  interactive           Start interactive environment variable manager');
  console.log('\nYou can also edit environment variables in the web UI:');
  console.log('  http://localhost:3000/settings');
});

/**
 * Display the main menu for environment variables
 */
async function showMainMenu(yes = false): Promise<void> {
  let exit = false;

  while (!exit) {
    let action: string | undefined;
    if (yes) {
      action = 'list'; // default to 'list' in non-interactive mode
    } else {
      const resp = await prompts({
        type: 'select',
        name: 'action',
        message: 'Select an action:',
        choices: [
          { title: 'List environment variables', value: 'list' },
          { title: 'Edit global environment variables', value: 'edit_global' },
          { title: 'Edit local environment variables', value: 'edit_local' },
          { title: 'Set custom environment path', value: 'set_path' },
          { title: 'Reset environment variables', value: 'reset' },
          { title: 'Exit', value: 'exit' },
        ],
      });
      action = resp.action;
    }
    if (!action || action === 'exit') {
      exit = true;
      continue;
    }
    switch (action) {
      case 'list':
        await listEnvVars();
        break;
      case 'edit_global': {
        const returnToMainFromGlobal = await editEnvVars('global', true);
        exit = !returnToMainFromGlobal;
        break;
      }
      case 'edit_local': {
        const returnToMainFromLocal = await editEnvVars('local', true);
        exit = !returnToMainFromLocal;
        break;
      }
      case 'set_path':
        // Prompt for a path and use the existing setEnvPath function
        const { path: customPath } = await prompts({
          type: 'text',
          name: 'path',
          message: 'Enter custom path for global environment file:',
        });

        if (customPath) {
          await setEnvPath(customPath, yes);
        }
        break;
      case 'reset':
        await resetEnv();
        break;
    }
  }
}
